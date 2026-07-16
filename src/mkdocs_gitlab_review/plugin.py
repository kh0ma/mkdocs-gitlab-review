"""MkDocs plugin that enables inline GitLab MR review comments."""

import hashlib
import json
import logging
import os
import shutil
from pathlib import Path

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin
from mkdocs.utils import get_relative_url

from .source_map import annotate_html, build_block_lines

log = logging.getLogger("mkdocs.plugins.gitlab_review")

# Where plugin assets land inside the built site. Pages reference these
# instead of inlining them, so each file is downloaded once and cached.
ASSET_SITE_DIR = "assets/gitlab-review"
CSS_FILES = ["review.css", "panel.css"]
# Load order matters: oauth → api → mentions → panel → review
JS_FILES = ["oauth.js", "api.js", "mentions.js", "panel.js", "review.js"]
PAGE_MAP_FILE = "page-map.js"


class GitLabReviewPlugin(BasePlugin):
    config_scheme = (
        ("enabled", config_options.Type(bool, default=True)),
        ("gitlab_url", config_options.Type(str, default="")),
        ("project_id", config_options.Type((str, int), default="")),
        ("oauth_client_id", config_options.Type(str, default="")),
    )

    def __init__(self):
        super().__init__()
        self._line_maps: dict[str, dict[str, int]] = {}
        self._page_map: dict[str, str] = {}  # git_path → mkdocs_url
        self._assets_dir = Path(__file__).parent / "assets"

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    def on_config(self, config):
        if not self.config["enabled"]:
            return config

        gitlab_url = self.config["gitlab_url"] or os.environ.get("CI_SERVER_URL", "")
        project_id = str(self.config["project_id"] or os.environ.get("CI_PROJECT_ID", ""))
        oauth_client_id = (
            self.config["oauth_client_id"] or os.environ.get("GITLAB_REVIEW_CLIENT_ID", "")
        )

        project_url = os.environ.get("CI_PROJECT_URL", gitlab_url)

        site_url = config.get("site_url", "") or ""

        mr_iid = os.environ.get("CI_MERGE_REQUEST_IID", "")

        self._plugin_config = {
            "gitlab_url": gitlab_url,
            "project_id": project_id,
            "project_url": project_url,
            "oauth_client_id": oauth_client_id,
            "site_url": site_url.rstrip("/") + "/",
            "mr_iid": int(mr_iid) if mr_iid else None,
        }

        if not gitlab_url or not project_id:
            log.warning("gitlab-review: gitlab_url or project_id not set, plugin disabled")
            self.config["enabled"] = False

        self._asset_version = self._compute_asset_version()

        return config

    def on_page_markdown(self, markdown, /, *, page, config, files):
        """Parse markdown and build a source line number map.

        Reads the ORIGINAL file from disk (not the hook-modified markdown)
        to get correct line numbers that match git diff positions.
        Hooks may prepend content (e.g. frontmatter tables), shifting lines.
        """
        if not self.config["enabled"]:
            return markdown

        src_path = page.file.src_path
        docs_dir = Path(config["docs_dir"])
        file_path = docs_dir / src_path

        try:
            original_md = file_path.resolve().read_text()
        except OSError:
            original_md = markdown

        # If file has frontmatter (---\n...\n---), skip it for line counting
        # since frontmatter lines are not in the rendered content
        lines = original_md.split("\n")
        offset = 0
        if lines and lines[0].strip() == "---":
            for i, line in enumerate(lines[1:], start=1):
                if line.strip() == "---":
                    offset = i + 1  # skip frontmatter + closing ---
                    break
            original_md = "\n".join(lines[offset:])

        block_lines = build_block_lines(original_md)
        # Adjust line numbers to account for frontmatter
        self._line_maps[src_path] = [ln + offset for ln in block_lines]
        return markdown

    def on_page_content(self, html, /, *, page, config, files):
        """Annotate HTML block elements with source file/line data attributes."""
        if not self.config["enabled"]:
            return html

        src_path = page.file.src_path
        git_path = self._resolve_git_path(src_path, config)
        line_map = self._line_maps.get(src_path, {})

        # Store git_path → MkDocs URL mapping
        page_url = page.file.dest_path.replace("index.html", "").replace(".html", "/")
        self._page_map[git_path] = page_url

        if not line_map:
            return html

        return annotate_html(html, git_path, line_map)

    def on_post_page(self, output, /, *, page, config):
        """Inject asset references and plugin config into rendered page."""
        if not self.config["enabled"]:
            return output

        injection = self._build_injection(page)
        return output.replace("</body>", injection + "\n</body>")

    def on_post_build(self, /, *, config):
        """Copy JS/CSS assets and write the page map into the built site.

        Runs after all pages are rendered, so the page map is complete —
        unlike per-page injection, which saw only pages rendered so far.
        """
        if not self.config["enabled"]:
            return

        out_dir = Path(config["site_dir"]) / ASSET_SITE_DIR
        out_dir.mkdir(parents=True, exist_ok=True)

        for name in CSS_FILES + JS_FILES:
            src = self._assets_dir / name
            if src.exists():
                shutil.copy2(src, out_dir / name)

        page_map_json = json.dumps(self._page_map)
        page_map = f"window.__GITLAB_REVIEW_PAGE_MAP__={page_map_json};"
        (out_dir / PAGE_MAP_FILE).write_text(page_map)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _resolve_git_path(self, src_path: str, config) -> str:
        """Resolve MkDocs src_path to the actual git-relative file path.

        Handles symlinks and the docs_dir prefix so that the path matches
        what appears in git diff / GitLab MR changes.
        """
        docs_dir = Path(config["docs_dir"])
        abs_path = docs_dir / src_path

        # Resolve symlinks to get the real file
        try:
            real_path = abs_path.resolve()
        except OSError:
            real_path = abs_path

        # Make relative to the git repo root (parent of docs_dir, typically)
        git_root = docs_dir.parent.resolve()
        try:
            return str(real_path.relative_to(git_root))
        except ValueError:
            # Fallback: return with docs/ prefix
            return str(Path("docs") / src_path)

    def _compute_asset_version(self) -> str:
        """Short content hash over all bundled assets, used for cache busting."""
        digest = hashlib.md5()
        for name in CSS_FILES + JS_FILES:
            path = self._assets_dir / name
            if path.exists():
                digest.update(path.read_bytes())
        return digest.hexdigest()[:8]

    def _asset_url(self, name: str, page) -> str:
        """URL of a site asset relative to the given page, with cache buster."""
        rel = get_relative_url(f"{ASSET_SITE_DIR}/{name}", page.url)
        return f"{rel}?v={self._asset_version}"

    def _build_injection(self, page) -> str:
        """Build the HTML to inject before </body>.

        Only the small per-site config is inlined; everything else is
        referenced as external files (written once in on_post_build) so
        the browser caches them across pages instead of re-downloading
        ~200KB of inlined JS/CSS with every page.
        """
        parts = []

        # Config as global variable
        config_json = json.dumps(self._plugin_config)
        parts.append(f'<script>window.__GITLAB_REVIEW__={config_json};</script>')

        # CDN dependencies
        parts.append(
            '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>'
        )
        # Quill.js WYSIWYG editor
        parts.append(
            '<link href="https://cdn.jsdelivr.net/npm/quill@2/dist/quill.snow.css"'
            ' rel="stylesheet">'
        )
        parts.append(
            '<script src="https://cdn.jsdelivr.net/npm/quill@2/dist/quill.js"></script>'
        )

        # CSS — review.css (core) + panel.css (review panel)
        for css_file in CSS_FILES:
            if (self._assets_dir / css_file).exists():
                parts.append(
                    f'<link rel="stylesheet" href="{self._asset_url(css_file, page)}">'
                )

        # Page map before plugin JS — scripts at end of body execute in order
        parts.append(
            f'<script src="{self._asset_url(PAGE_MAP_FILE, page)}"></script>'
        )

        # JS — oauth → api → mentions → panel → main (load order matters)
        for js_file in JS_FILES:
            if (self._assets_dir / js_file).exists():
                parts.append(
                    f'<script src="{self._asset_url(js_file, page)}"></script>'
                )

        return "\n".join(parts)

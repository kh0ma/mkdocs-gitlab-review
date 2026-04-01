"""MkDocs plugin that enables inline GitLab MR review comments."""

import json
import logging
import os
from importlib.resources import files as pkg_files
from pathlib import Path

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin

from .source_map import annotate_html, build_block_lines

log = logging.getLogger("mkdocs.plugins.gitlab_review")


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
        self._assets_dir = Path(__file__).parent / "assets"

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    def on_config(self, config):
        if not self.config["enabled"]:
            return config

        gitlab_url = self.config["gitlab_url"] or os.environ.get("CI_SERVER_URL", "")
        project_id = str(self.config["project_id"] or os.environ.get("CI_PROJECT_ID", ""))
        oauth_client_id = self.config["oauth_client_id"] or os.environ.get("GITLAB_REVIEW_CLIENT_ID", "")

        project_url = os.environ.get("CI_PROJECT_URL", gitlab_url)

        site_url = config.get("site_url", "") or ""

        self._plugin_config = {
            "gitlab_url": gitlab_url,
            "project_id": project_id,
            "project_url": project_url,
            "oauth_client_id": oauth_client_id,
            "site_url": site_url.rstrip("/") + "/",
        }

        if not gitlab_url or not project_id:
            log.warning("gitlab-review: gitlab_url or project_id not set, plugin disabled")
            self.config["enabled"] = False

        return config

    def on_page_markdown(self, markdown, /, *, page, config, files):
        """Parse markdown and build a source line number map."""
        if not self.config["enabled"]:
            return markdown

        src_path = page.file.src_path
        self._line_maps[src_path] = build_block_lines(markdown)
        return markdown

    def on_page_content(self, html, /, *, page, config, files):
        """Annotate HTML block elements with source file/line data attributes."""
        if not self.config["enabled"]:
            return html

        src_path = page.file.src_path
        git_path = self._resolve_git_path(src_path, config)
        line_map = self._line_maps.get(src_path, {})

        if not line_map:
            return html

        return annotate_html(html, git_path, line_map)

    def on_post_page(self, output, /, *, page, config):
        """Inject JS/CSS assets and plugin config into rendered page."""
        if not self.config["enabled"]:
            return output

        injection = self._build_injection()
        return output.replace("</body>", injection + "\n</body>")

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
        # Try to find the git root by walking up
        git_root = docs_dir.parent
        try:
            return str(real_path.relative_to(git_root))
        except ValueError:
            # Fallback: return with docs/ prefix
            return str(Path("docs") / src_path)

    def _build_injection(self) -> str:
        """Build the HTML to inject before </body>."""
        parts = []

        # Config as global variable
        config_json = json.dumps(self._plugin_config)
        parts.append(
            f'<script>window.__GITLAB_REVIEW__={config_json};</script>'
        )

        # CDN dependencies
        parts.append(
            '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>'
        )

        # CSS
        css_path = self._assets_dir / "review.css"
        if css_path.exists():
            css = css_path.read_text()
            parts.append(f"<style>{css}</style>")

        # JS — oauth first, then main
        for js_file in ["oauth.js", "review.js"]:
            js_path = self._assets_dir / js_file
            if js_path.exists():
                js = js_path.read_text()
                parts.append(f"<script>{js}</script>")

        return "\n".join(parts)

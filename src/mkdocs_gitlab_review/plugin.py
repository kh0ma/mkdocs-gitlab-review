"""MkDocs plugin that enables inline GitLab MR review comments."""

import json
import logging
import os
from importlib.resources import files as pkg_files
from pathlib import Path

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin

from .source_map import annotate_html, build_line_map

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

        self._plugin_config = {
            "gitlab_url": gitlab_url,
            "project_id": project_id,
            "oauth_client_id": oauth_client_id,
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
        self._line_maps[src_path] = build_line_map(markdown)
        return markdown

    def on_page_content(self, html, /, *, page, config, files):
        """Annotate HTML block elements with source file/line data attributes."""
        if not self.config["enabled"]:
            return html

        src_path = page.file.src_path
        line_map = self._line_maps.get(src_path, {})

        if not line_map:
            return html

        return annotate_html(html, src_path, line_map)

    def on_post_page(self, output, /, *, page, config):
        """Inject JS/CSS assets and plugin config into rendered page."""
        if not self.config["enabled"]:
            return output

        injection = self._build_injection()
        return output.replace("</body>", injection + "\n</body>")

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_injection(self) -> str:
        """Build the HTML to inject before </body>."""
        parts = []

        # Config as global variable
        config_json = json.dumps(self._plugin_config)
        parts.append(
            f'<script>window.__GITLAB_REVIEW__={config_json};</script>'
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

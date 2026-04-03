"""Tests for the GitLabReviewPlugin — config, hooks, and injection."""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from mkdocs_gitlab_review.plugin import GitLabReviewPlugin


@pytest.fixture
def plugin():
    p = GitLabReviewPlugin()
    # Simulate MkDocs loading the config scheme defaults
    p.config = {
        "enabled": True,
        "gitlab_url": "https://gitlab.example.com",
        "project_id": "42",
        "oauth_client_id": "test-client-id",
    }
    return p


@pytest.fixture
def mkdocs_config(tmp_path):
    """Minimal MkDocs-like config dict."""
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    return {
        "docs_dir": str(docs_dir),
        "site_url": "https://docs.example.com",
    }


# ── on_config ──────────────────────────────────────────────────────


class TestOnConfig:
    def test_sets_plugin_config(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)
        assert plugin._plugin_config["gitlab_url"] == "https://gitlab.example.com"
        assert plugin._plugin_config["project_id"] == "42"
        assert plugin._plugin_config["oauth_client_id"] == "test-client-id"
        assert plugin._plugin_config["site_url"] == "https://docs.example.com/"

    def test_disabled_when_no_gitlab_url(self, plugin, mkdocs_config):
        plugin.config["gitlab_url"] = ""
        with patch.dict(os.environ, {}, clear=True):
            plugin.on_config(mkdocs_config)
        assert plugin.config["enabled"] is False

    def test_disabled_when_no_project_id(self, plugin, mkdocs_config):
        plugin.config["project_id"] = ""
        with patch.dict(os.environ, {}, clear=True):
            plugin.on_config(mkdocs_config)
        assert plugin.config["enabled"] is False

    def test_env_vars_override_config(self, plugin, mkdocs_config):
        plugin.config["gitlab_url"] = ""
        plugin.config["project_id"] = ""
        plugin.config["oauth_client_id"] = ""
        env = {
            "CI_SERVER_URL": "https://ci-gitlab.example.com",
            "CI_PROJECT_ID": "99",
            "GITLAB_REVIEW_CLIENT_ID": "env-client-id",
            "CI_PROJECT_URL": "https://ci-gitlab.example.com/group/project",
        }
        with patch.dict(os.environ, env, clear=True):
            plugin.on_config(mkdocs_config)
        assert plugin._plugin_config["gitlab_url"] == "https://ci-gitlab.example.com"
        assert plugin._plugin_config["project_id"] == "99"
        assert plugin._plugin_config["oauth_client_id"] == "env-client-id"
        assert plugin._plugin_config["project_url"] == "https://ci-gitlab.example.com/group/project"

    def test_disabled_plugin_returns_config(self, plugin, mkdocs_config):
        plugin.config["enabled"] = False
        result = plugin.on_config(mkdocs_config)
        assert result == mkdocs_config

    def test_site_url_trailing_slash(self, plugin, mkdocs_config):
        mkdocs_config["site_url"] = "https://docs.example.com"
        plugin.on_config(mkdocs_config)
        assert plugin._plugin_config["site_url"] == "https://docs.example.com/"

    def test_site_url_already_trailing_slash(self, plugin, mkdocs_config):
        mkdocs_config["site_url"] = "https://docs.example.com/"
        plugin.on_config(mkdocs_config)
        assert plugin._plugin_config["site_url"] == "https://docs.example.com/"


# ── on_page_markdown ───────────────────────────────────────────────


class TestOnPageMarkdown:
    def test_builds_line_map(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)
        page = MagicMock()
        page.file.src_path = "index.md"

        md = "# Title\n\nParagraph"
        result = plugin.on_page_markdown(md, page=page, config=mkdocs_config, files=None)

        assert result == md  # markdown is not modified
        assert "index.md" in plugin._line_maps
        assert plugin._line_maps["index.md"] == [1, 3]

    def test_disabled_returns_markdown(self, plugin, mkdocs_config):
        plugin.config["enabled"] = False
        page = MagicMock()

        md = "# Title"
        result = plugin.on_page_markdown(md, page=page, config=mkdocs_config, files=None)
        assert result == md


# ── on_page_content ────────────────────────────────────────────────


class TestOnPageContent:
    def test_annotates_html(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)
        page = MagicMock()
        page.file.src_path = "index.md"

        # Build line map first
        plugin.on_page_markdown("# Title\n\nParagraph", page=page, config=mkdocs_config, files=None)

        html = "<h1>Title</h1>\n<p>Paragraph</p>"
        result = plugin.on_page_content(html, page=page, config=mkdocs_config, files=None)

        assert "data-source-file" in result
        assert "data-source-line" in result

    def test_disabled_returns_html(self, plugin, mkdocs_config):
        plugin.config["enabled"] = False
        page = MagicMock()

        html = "<p>Test</p>"
        result = plugin.on_page_content(html, page=page, config=mkdocs_config, files=None)
        assert result == html


# ── on_post_page ───────────────────────────────────────────────────


class TestOnPostPage:
    def test_injects_before_body_close(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)
        page = MagicMock()

        output = "<html><body><p>Content</p></body></html>"
        result = plugin.on_post_page(output, page=page, config=mkdocs_config)

        assert "__GITLAB_REVIEW__" in result
        assert "marked.min.js" in result
        assert "quill" in result
        assert result.index("__GITLAB_REVIEW__") < result.index("</body>")

    def test_injects_config_json(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)
        page = MagicMock()

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=page, config=mkdocs_config)

        # Extract the JSON from the script tag
        start = result.index("__GITLAB_REVIEW__=") + len("__GITLAB_REVIEW__=")
        end = result.index(";</script>", start)
        config_data = json.loads(result[start:end])

        assert config_data["gitlab_url"] == "https://gitlab.example.com"
        assert config_data["project_id"] == "42"

    def test_disabled_returns_output(self, plugin, mkdocs_config):
        plugin.config["enabled"] = False
        page = MagicMock()

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=page, config=mkdocs_config)
        assert result == output

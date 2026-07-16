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


def _page(url=""):
    page = MagicMock()
    page.url = url
    return page


class TestOnPostPage:
    def test_injects_before_body_close(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)

        output = "<html><body><p>Content</p></body></html>"
        result = plugin.on_post_page(output, page=_page(), config=mkdocs_config)

        assert "__GITLAB_REVIEW__" in result
        assert "marked.min.js" in result
        assert "quill" in result
        assert result.index("__GITLAB_REVIEW__") < result.index("</body>")

    def test_injects_config_json(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=_page(), config=mkdocs_config)

        # Extract the JSON from the script tag
        start = result.index("__GITLAB_REVIEW__=") + len("__GITLAB_REVIEW__=")
        end = result.index(";</script>", start)
        config_data = json.loads(result[start:end])

        assert config_data["gitlab_url"] == "https://gitlab.example.com"
        assert config_data["project_id"] == "42"

    def test_references_external_assets_instead_of_inlining(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=_page(), config=mkdocs_config)

        version = plugin._asset_version
        assert f'src="assets/gitlab-review/review.js?v={version}"' in result
        assert f'src="assets/gitlab-review/page-map.js?v={version}"' in result
        assert f'href="assets/gitlab-review/review.css?v={version}"' in result
        # Nothing bulky is inlined anymore
        assert "<style>" not in result
        assert "use strict" not in result
        assert "__GITLAB_REVIEW_PAGE_MAP__" not in result

    def test_asset_urls_are_relative_to_page_depth(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)

        output = "<html><body></body></html>"
        result = plugin.on_post_page(
            output, page=_page("specs/design-docs/checkout/"), config=mkdocs_config
        )

        assert 'src="../../../assets/gitlab-review/review.js' in result

    def test_page_map_loads_before_plugin_scripts(self, plugin, mkdocs_config):
        plugin.on_config(mkdocs_config)

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=_page(), config=mkdocs_config)

        assert result.index("page-map.js") < result.index("oauth.js")

    def test_disabled_returns_output(self, plugin, mkdocs_config):
        plugin.config["enabled"] = False

        output = "<html><body></body></html>"
        result = plugin.on_post_page(output, page=_page(), config=mkdocs_config)
        assert result == output


# ── on_post_build ──────────────────────────────────────────────────


class TestOnPostBuild:
    def test_writes_assets_and_page_map(self, plugin, mkdocs_config, tmp_path):
        plugin.on_config(mkdocs_config)
        site_dir = tmp_path / "site"
        mkdocs_config["site_dir"] = str(site_dir)

        # Simulate a rendered page having registered itself in the map
        plugin._page_map["specs/index.md"] = "specs/"

        plugin.on_post_build(config=mkdocs_config)

        asset_dir = site_dir / "assets" / "gitlab-review"
        for name in ["review.css", "panel.css", "oauth.js", "api.js",
                     "mentions.js", "panel.js", "review.js"]:
            assert (asset_dir / name).exists(), name

        page_map = (asset_dir / "page-map.js").read_text()
        assert page_map.startswith("window.__GITLAB_REVIEW_PAGE_MAP__=")
        assert '"specs/index.md": "specs/"' in page_map

    def test_disabled_writes_nothing(self, plugin, mkdocs_config, tmp_path):
        plugin.config["enabled"] = False
        site_dir = tmp_path / "site"
        mkdocs_config["site_dir"] = str(site_dir)

        plugin.on_post_build(config=mkdocs_config)

        assert not site_dir.exists()

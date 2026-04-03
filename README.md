# mkdocs-gitlab-review

An MkDocs plugin that brings **inline GitLab Merge Request review comments** directly into your rendered documentation pages. Reviewers can read docs in their final rendered form and leave comments tied to specific lines — no more switching between raw markdown and the MR diff.

![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue)
![MkDocs 1.4+](https://img.shields.io/badge/mkdocs-1.4%2B-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Features

- **Inline MR discussions** — View and create review threads anchored to specific content blocks on the rendered page
- **Rich text editor** — Comment with markdown using a Quill.js WYSIWYG editor
- **Image uploads** — Paste or drag images into comments; uploaded to GitLab automatically
- **OAuth 2.0 PKCE** — Secure browser-based authentication with no backend required
- **CI-friendly** — Auto-configures from GitLab CI environment variables
- **Source mapping** — Maps rendered HTML blocks back to markdown source lines for accurate diff-aware comments
- **Paginated discussions** — Handles MRs with any number of discussion threads
- **MkDocs Material compatible** — Styled to integrate with the Material theme

## How It Works

1. The plugin annotates rendered HTML elements with `data-source-file` and `data-source-line` attributes during the MkDocs build
2. Client-side JavaScript detects the MR context from the URL (e.g., `?mr=123`)
3. Users authenticate via OAuth 2.0 PKCE flow (no client secret needed)
4. The overlay fetches MR discussions from the GitLab API and anchors them to the correct content blocks
5. New comments are posted as inline diff comments when the line is in the diff, or as general discussions with file:line context otherwise

## Installation

```bash
pip install mkdocs-gitlab-review
```

Or install from source:

```bash
pip install git+https://github.com/user/mkdocs-gitlab-review.git
```

For development:

```bash
git clone https://github.com/user/mkdocs-gitlab-review.git
cd mkdocs-gitlab-review
pip install -e ".[test]"
```

## Configuration

Add the plugin to your `mkdocs.yml`:

```yaml
plugins:
  - search
  - gitlab-review:
      gitlab_url: "https://gitlab.example.com"
      project_id: "12345"
      oauth_client_id: "your-oauth-app-id"
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `bool` | `true` | Enable/disable the plugin |
| `gitlab_url` | `str` | `""` | GitLab instance URL |
| `project_id` | `str\|int` | `""` | GitLab project ID |
| `oauth_client_id` | `str` | `""` | OAuth 2.0 application ID for PKCE auth |

### Environment Variables

All options can be set via environment variables, making it easy to configure in CI/CD:

| Environment Variable | Overrides |
|---------------------|-----------|
| `CI_SERVER_URL` | `gitlab_url` |
| `CI_PROJECT_ID` | `project_id` |
| `CI_PROJECT_URL` | Used for project URL resolution |
| `GITLAB_REVIEW_CLIENT_ID` | `oauth_client_id` |

These are automatically available in GitLab CI pipelines (except `GITLAB_REVIEW_CLIENT_ID`, which you set in CI/CD variables).

## GitLab OAuth Setup

1. In your GitLab project, go to **Settings → Applications**
2. Create a new application:
   - **Name**: MkDocs Review (or any name)
   - **Redirect URI**: Your docs site URL (e.g., `https://docs.example.com/*`)
   - **Confidential**: No (uncheck — PKCE flow doesn't use a client secret)
   - **Scopes**: `api`
3. Copy the **Application ID** and use it as `oauth_client_id`

## Usage

### Viewing Reviews

Navigate to your docs with an MR parameter:

```
https://docs.example.com/page/?mr=42
```

Click the review toggle button to activate the overlay. You'll be prompted to authenticate via GitLab OAuth if not already logged in.

### Writing Comments

- Click the comment button (shows `+` or comment count) next to any content block
- Type your comment using the rich text editor
- Attach images by pasting or using the image button
- Submit to create an inline diff comment or general discussion

## Development

```bash
# Install with test dependencies
pip install -e ".[test]"

# Run tests
pytest

# Run tests with coverage
pytest --cov=mkdocs_gitlab_review

# Lint
ruff check src/ tests/
```

### Project Structure

```
src/mkdocs_gitlab_review/
├── __init__.py          # Package init
├── plugin.py            # MkDocs plugin hooks (on_config, on_page_markdown, etc.)
├── source_map.py        # Markdown→HTML block line mapping
└── assets/
    ├── oauth.js         # OAuth 2.0 PKCE client-side auth
    ├── review.js        # Review overlay UI and GitLab API integration
    └── review.css       # Overlay styling
```

## Releasing

This project uses git tags for versioning via `setuptools-scm`. To create a new release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The GitHub Actions release workflow will automatically build and publish to PyPI.

## License

MIT

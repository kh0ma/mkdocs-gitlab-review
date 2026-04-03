"""Tests for source_map module — markdown→HTML block line mapping."""

from mkdocs_gitlab_review.source_map import (
    annotate_html,
    build_block_lines,
)

# ── build_block_lines ──────────────────────────────────────────────


class TestBuildBlockLines:
    def test_single_paragraph(self):
        md = "Hello world"
        assert build_block_lines(md) == [1]

    def test_two_paragraphs(self):
        md = "First paragraph\n\nSecond paragraph"
        assert build_block_lines(md) == [1, 3]

    def test_heading_is_own_block(self):
        md = "# Title\nBody text"
        result = build_block_lines(md)
        assert result == [1, 2]

    def test_heading_then_paragraph(self):
        md = "# Title\n\nBody text"
        result = build_block_lines(md)
        assert result == [1, 3]

    def test_multiple_headings(self):
        md = "# H1\n\n## H2\n\nParagraph"
        result = build_block_lines(md)
        assert result == [1, 3, 5]

    def test_fenced_code_block(self):
        md = "Before\n\n```python\ncode here\nmore code\n```\n\nAfter"
        result = build_block_lines(md)
        assert result == [1, 3, 8]

    def test_tilde_fenced_code_block(self):
        md = "Before\n\n~~~\ncode\n~~~\n\nAfter"
        result = build_block_lines(md)
        assert result == [1, 3, 7]

    def test_blank_lines_separate_blocks(self):
        md = "A\n\n\n\nB"
        result = build_block_lines(md)
        assert result == [1, 5]

    def test_empty_input(self):
        assert build_block_lines("") == []

    def test_only_blank_lines(self):
        assert build_block_lines("\n\n\n") == []

    def test_horizontal_rule(self):
        md = "Above\n\n---\n\nBelow"
        result = build_block_lines(md)
        assert result == [1, 3, 5]

    def test_multiline_paragraph(self):
        md = "Line one\nLine two\nLine three"
        result = build_block_lines(md)
        assert result == [1]

    def test_list_block(self):
        md = "Intro\n\n- item 1\n- item 2\n- item 3"
        result = build_block_lines(md)
        assert result == [1, 3]

    def test_table_block(self):
        md = "Text\n\n| A | B |\n|---|---|\n| 1 | 2 |"
        result = build_block_lines(md)
        assert result == [1, 3]

    def test_heading_levels(self):
        md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6"
        result = build_block_lines(md)
        assert result == [1, 2, 3, 4, 5, 6]

    def test_underscore_hr(self):
        md = "Above\n\n___\n\nBelow"
        result = build_block_lines(md)
        assert result == [1, 3, 5]

    def test_asterisk_hr(self):
        md = "Above\n\n***\n\nBelow"
        result = build_block_lines(md)
        assert result == [1, 3, 5]


# ── annotate_html ──────────────────────────────────────────────────


class TestAnnotateHtml:
    def test_single_paragraph(self):
        html = "<p>Hello</p>"
        result = annotate_html(html, "docs/index.md", [1])
        assert 'data-source-file="docs/index.md"' in result
        assert 'data-source-line="1"' in result

    def test_multiple_blocks(self):
        html = "<h1>Title</h1>\n<p>Body</p>"
        result = annotate_html(html, "page.md", [1, 3])
        assert 'data-source-line="1"' in result
        assert 'data-source-line="3"' in result

    def test_skips_container_tags(self):
        html = "<ul><li>item</li></ul>"
        result = annotate_html(html, "page.md", [1])
        # ul is a container tag, should not be annotated
        assert "data-source-line" not in result

    def test_preserves_existing_attrs(self):
        html = '<p class="intro">Text</p>'
        result = annotate_html(html, "page.md", [1])
        assert 'class="intro"' in result
        assert 'data-source-file="page.md"' in result

    def test_empty_block_lines(self):
        html = "<p>Text</p>"
        result = annotate_html(html, "page.md", [])
        assert result == html

    def test_more_html_blocks_than_lines(self):
        html = "<h1>A</h1>\n<p>B</p>\n<p>C</p>"
        # Only 2 block_lines for 3 blocks — stops at 2
        result = annotate_html(html, "page.md", [1, 3])
        assert result.count("data-source-line") == 2

    def test_table_annotation(self):
        html = "<table><tr><td>Cell</td></tr></table>"
        result = annotate_html(html, "page.md", [5])
        assert 'data-source-line="5"' in result

    def test_pre_annotation(self):
        html = "<pre><code>code</code></pre>"
        result = annotate_html(html, "page.md", [1])
        assert 'data-source-line="1"' in result

    def test_hr_annotation(self):
        html = "<hr>"
        result = annotate_html(html, "page.md", [3])
        assert 'data-source-line="3"' in result

    def test_case_insensitive_tags(self):
        html = "<P>text</P>"
        result = annotate_html(html, "page.md", [1])
        assert 'data-source-line="1"' in result

    def test_h1_through_h6(self):
        html = "<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>"
        result = annotate_html(html, "page.md", [1, 2, 3, 4, 5, 6])
        assert result.count("data-source-line") == 6

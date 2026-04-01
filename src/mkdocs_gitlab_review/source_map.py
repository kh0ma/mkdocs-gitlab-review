"""Map markdown source lines to rendered HTML block elements.

Given the raw markdown text, builds a mapping that allows annotating
each block-level HTML element with its corresponding source line number.
"""

import re
from html.parser import HTMLParser

# Block-level HTML tags that we want to annotate
BLOCK_TAGS = frozenset([
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "ul", "ol", "li",
    "table", "blockquote", "pre",
    "div",  # admonitions render as divs
    "details",
    "hr",
])


def build_line_map(markdown: str) -> dict[str, int]:
    """Build a map from normalized text content to source line number.

    Returns a dict where keys are the first ~80 chars of each block's text
    (stripped, lowered) and values are 1-based line numbers.
    """
    line_map = {}
    lines = markdown.split("\n")

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped:
            continue
        # Normalize: remove markdown syntax, keep text
        text = _strip_markdown(stripped)
        if text:
            key = text[:80].lower()
            if key not in line_map:
                line_map[key] = i

    return line_map


def _strip_markdown(text: str) -> str:
    """Remove common markdown formatting to get plain text for matching."""
    # Headings
    text = re.sub(r"^#{1,6}\s+", "", text)
    # Bold/italic
    text = re.sub(r"\*{1,3}(.+?)\*{1,3}", r"\1", text)
    text = re.sub(r"_{1,3}(.+?)_{1,3}", r"\1", text)
    # Links [text](url)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Inline code
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # List markers
    text = re.sub(r"^[-*+]\s+", "", text)
    text = re.sub(r"^\d+\.\s+", "", text)
    # Blockquote
    text = re.sub(r"^>\s*", "", text)
    return text.strip()


class _TextExtractor(HTMLParser):
    """Extract text content from an HTML element."""

    def __init__(self):
        super().__init__()
        self.parts = []
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        self._depth += 1

    def handle_endtag(self, tag):
        self._depth -= 1

    def handle_data(self, data):
        self.parts.append(data)

    def get_text(self) -> str:
        return "".join(self.parts).strip()


def extract_text(html_fragment: str) -> str:
    """Extract plain text from an HTML fragment."""
    parser = _TextExtractor()
    parser.feed(html_fragment)
    return parser.get_text()


def annotate_html(html: str, source_file: str, line_map: dict[str, int]) -> str:
    """Add data-source-file and data-source-line attributes to block elements.

    Walks through the HTML, finds block-level opening tags, extracts their
    text content, matches against the line_map, and injects attributes.
    """
    result = []
    pos = 0
    tag_re = re.compile(
        r"<(" + "|".join(BLOCK_TAGS) + r")(\s[^>]*)?>",
        re.IGNORECASE,
    )

    for match in tag_re.finditer(html):
        tag_name = match.group(1).lower()
        tag_start = match.start()
        tag_end = match.end()

        # Find the closing tag to extract text content
        close_pattern = re.compile(
            rf"</{re.escape(tag_name)}\s*>", re.IGNORECASE
        )
        close_match = close_pattern.search(html, tag_end)
        if not close_match:
            continue

        inner_html = html[tag_end:close_match.start()]
        text = extract_text(inner_html)

        if not text:
            continue

        key = _strip_markdown(text)[:80].lower()
        line_num = line_map.get(key)

        if line_num is None:
            continue

        # Inject data attributes into the opening tag
        attrs = f' data-source-file="{source_file}" data-source-line="{line_num}"'
        # Insert before the closing > of the opening tag
        insert_pos = tag_end - 1  # position of >
        result.append(html[pos:insert_pos])
        result.append(attrs)
        result.append(">")
        pos = tag_end

    result.append(html[pos:])
    return "".join(result)

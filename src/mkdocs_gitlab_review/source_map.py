"""Map markdown source lines to rendered HTML block elements.

Builds a sequential mapping: the N-th block-level HTML element
corresponds to the N-th content block in the markdown source.
"""

import re

# Block-level HTML tags that we annotate
BLOCK_TAGS = frozenset([
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "ul", "ol", "li",
    "table", "blockquote", "pre",
    "details", "hr",
])

# Tags whose children we skip (they are block-level but contain nested blocks)
CONTAINER_TAGS = frozenset(["ul", "ol", "blockquote", "details"])


def build_block_lines(markdown: str) -> list[int]:
    """Extract the starting line number of each content block in markdown.

    A 'content block' is a contiguous group of non-empty lines separated
    by blank lines (or a heading/hr/table/fence boundary).

    Returns a list of 1-based line numbers, one per block, in order.
    """
    lines = markdown.split("\n")
    block_lines = []
    in_block = False
    in_fence = False

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Track fenced code blocks
        if stripped.startswith("```") or stripped.startswith("~~~"):
            if not in_fence:
                in_fence = True
                if not in_block:
                    block_lines.append(i)
                    in_block = True
                continue
            else:
                in_fence = False
                in_block = False
                continue

        if in_fence:
            continue

        if not stripped:
            in_block = False
            continue

        if not in_block:
            block_lines.append(i)
            in_block = True

        # Headings and HRs are always their own block
        if re.match(r"^#{1,6}\s", stripped) or re.match(r"^(-{3,}|_{3,}|\*{3,})$", stripped):
            in_block = False

    return block_lines


def annotate_html(html: str, source_file: str, block_lines: list[int]) -> str:
    """Add data-source-file and data-source-line to block-level HTML elements.

    Matches HTML blocks sequentially with markdown block_lines.
    Skips blocks before <!-- source-content --> marker if present.
    Skips <p> and <pre> that are direct children of <li> (loose list rendering).
    """
    if not block_lines:
        return html

    # Find source-content marker — blocks before it are hook-generated
    marker = "<!-- source-content -->"
    marker_pos = html.find(marker)
    search_start = marker_pos + len(marker) if marker_pos != -1 else 0

    # Match opening and closing tags we care about
    tag_pattern = re.compile(
        r"<(/)?(li|" + "|".join(BLOCK_TAGS) + r")(\s[^>]*)?>",
        re.IGNORECASE,
    )

    result = []
    pos = 0
    line_idx = 0
    li_depth = 0  # track if we're inside a <li>

    for match in tag_pattern.finditer(html):
        is_close = match.group(1) == "/"
        tag_name = match.group(2).lower()

        # Track li open/close to detect p-inside-li
        if tag_name == "li":
            if not is_close:
                li_depth += 1
            else:
                li_depth = max(0, li_depth - 1)
            # li itself is handled below when not a closing tag
            if is_close:
                continue

        if is_close:
            continue

        # Skip container tags — their children are the real blocks
        if tag_name in CONTAINER_TAGS:
            continue

        # Skip <p> and <pre> that are inside a <li> (loose list: <li><p>text</p></li>)
        if tag_name in ("p", "pre") and li_depth > 0:
            continue

        # Skip blocks before source-content marker
        if match.start() < search_start:
            continue

        if line_idx >= len(block_lines):
            break

        tag_end = match.end()
        insert_pos = tag_end - 1  # position of >
        line_num = block_lines[line_idx]
        line_idx += 1

        attrs = f' data-source-file="{source_file}" data-source-line="{line_num}"'
        result.append(html[pos:insert_pos])
        result.append(attrs)
        result.append(">")
        pos = tag_end

    result.append(html[pos:])
    return "".join(result)

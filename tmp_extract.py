import sys
import re

for filename in sys.argv[1:]:
    print(f"\n\n--- {filename} ---")
    with open(filename, "r", encoding="utf-8") as f:
        content = f.read()
        main_content = re.search(r"<main>(.*?)</main>", content, re.DOTALL)
        if main_content:
            text = main_content.group(1)
            # Remove appendix
            text = re.sub(r"<h2 id=\"appendix-a\">.*", "", text, flags=re.DOTALL)
            # Strip some tags for readability
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text)
            print(text)

# jtxt.org

The site of James Thomas, a creative technologist in Salt Lake City: 3D, XR, projection mapping, web,
and free tools for artists. Live at [jtxt.org](https://jtxt.org), served by GitHub Pages from this repo.

Plain HTML, CSS, and JavaScript. No build step: edit a file, push, and it's live.

## Tools

Free, no account, no ads. Images stay on your device; nothing is uploaded.

| Tool | What it does |
|---|---|
| [Squint](https://jtxt.org/tools/squint/) | Breaks a reference photo into a few value shapes, like squinting at it |
| [Flicker](https://jtxt.org/tools/flicker/) | Lines up two images by hand and flips between them, to spot the differences |
| [Compare](https://jtxt.org/tools/compare/) | Lines a drawing up on its reference by itself, with arrows where it drifts |
| [Squint & Check](https://jtxt.org/tools/squint-check/) | Squint and Compare in one app (in progress) |

To run a tool locally, serve the folder (the background workers won't start from a file):

```
python3 -m http.server 8765
```

then open `http://localhost:8765/tools/<tool>/`.

## Layout

- `index.html`, `404.html`: the homepage, and the page for any link that doesn't exist
- `work/`: portfolio
- `tools/<tool>/`: one folder per tool

## License

Not chosen yet. Until there is one, please ask before reusing the code.

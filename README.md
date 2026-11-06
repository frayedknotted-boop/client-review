# dailyRushes Client Review

A web page for clients to review a video. They watch it in the browser, leave comments at exact frames and export the comments as a file for the editor. There are no accounts, nothing to install, no server code and nothing is uploaded: the review file is read in the browser, and the video plays straight from wherever the editor put it.

The review file is made by **Marker Edits** (in DaVinci Resolve, **Send to Client**) or by the [Markers Cross NLE Generator](https://dailyrushes.store/markernotes-creator). The client's comments file is imported back with Marker Edits (**Import Client Comments**) or the Generator.

The hosted version is at [dailyrushes.store/review](https://dailyrushes.store/review).

## Files

| File | What it is |
| --- | --- |
| `review.html` | The page around the review: title, header and footer. Change these to your own name if you like. |
| `review-widget.js` | The video player and comments. One file, no dependencies. Don't edit it: Marker Edits replaces it with new versions. |
| `videos/` | Where the review video goes when it is sent in a review folder. |

## Using it

### As a review folder

1. Put the video in `videos/` and set the review file's video link to `videos/your-video.mp4`.
2. Zip `review.html`, `review-widget.js`, `videos/` and the review file, and send it.
3. The client unzips it, opens `review.html` and drops the review file on the page.

Marker Edits builds this folder for you (**Send to Client → Review folder**).

### On your own website

Upload `review.html` and `review-widget.js`. Then send only the review file, with the video link set to the video's full `https://` address, plus the page's address.

### In your own page

```html
<div id="video-review-widget"></div>
<script src="review-widget.js"></script>
<script>
  ReviewWidget.init({ container: '#video-review-widget' });
</script>
```

| Option | What it does |
| --- | --- |
| `container` | The element, or a selector for it, that the review goes in. Required. |
| `hosted` | `true` for a page that serves everyone's reviews, not one sitting next to the editor's `videos` folder. A video link that is only a path (`videos/cut.mp4`) is then refused with a clear message. |
| `favicon` | A PNG to use as the page icon. Ignored if the page already has one. |

## Video links

The video must be a file the browser can play, ideally an **H.264 MP4**.

- **Work:** a path next to `review.html` (review folders only), Dropbox links ending in `raw=1`, a link to the file on a website, and file hosts such as Cloudflare R2 or Bunny.
- **Don't work:** Google Drive, OneDrive, WeTransfer, YouTube, Vimeo and iCloud page links, `http://` links on an `https://` page, and files on the editor's computer.

The widget explains a link that can't work before it tries to load the video. Dropbox `dl=0` links are changed to `raw=1`.

## File format

Review and comments files are JSON in **dailyRushes client review format 1**. Files in any other format are refused.

- The editor's **review file** has `"format": 1, "kind": "review"`, plus the project, timeline, client, video link, frame rate (`fps`, `frameRate`, `dropFrame`), start timecode, In and Out points, and the message and notes for the client.
- The client's **comments file** has `"kind": "comments"`, the same fields, a `comments` list (`frame`, `timecode`, `comment`), and a `check` block. That block records the length of the video the client actually watched and every warning they were shown, such as a video length that didn't match the review.

Timecode matches the editor's timeline: start timecode + In point + frame. The exact frame rate is used, so 23.976, 29.97 and 59.94 reviews don't drift, and drop-frame timecode is supported.

Dropping a comments file on the page opens the video with every comment listed and marked on the progress bar, along with the warnings the client saw.

## For the client

- **Space** plays and pauses, **←** and **→** step one frame, and **C** adds a comment.
- Comments aren't saved until they are exported, so keep the tab open until you've finished.

Full instructions: [How to review a video](https://dailyrushes.store/help/client-review-client). For editors: [Client Review help](https://dailyrushes.store/help/client-review-editor).

## For browser tools

The `.vrw-root` element carries the review settings and the current position as data attributes: `data-vrw-fps`, `data-vrw-frame-rate`, `data-vrw-start-tc`, `data-vrw-in-frame`, `data-vrw-tc`, `data-vrw-frame`, `data-vrw-timeline-frame` and `data-vrw-paused`.

# Remote image preview

Development source `0.3.0-alpha.4` provides **Preview image** on regular files named `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif` in the explorer. The content signature and decoder determine the actual format; a filename alone never establishes trust. SVG, HTML, other formats, symlinks, special files and files with special permission bits are refused.

The dialog shows the oriented image dimensions, original format and encoded source size. Fit to window adapts the view to the panel. Actual size uses one image pixel per CSS pixel; zoom ranges from 25% to 400%, with scrolling at larger sizes. Animated GIF/WebP images are displayed as a still first frame. There is no editing, saving, automatic external opening or animation playback.

## Bounds and network behavior

Sources are limited to 10 MiB. The decoder accepts at most 8,388,608 pixels and 8,192 pixels per side, refuses malformed data and has a ten-second processing limit. Reads reuse the stable regular-file and canonical-parent checks from verified transfers, with a 60-second overall operation deadline. One file operation runs at a time; finish transfers/workflows before previewing.

The loading dialog has Cancel preview; Escape and closing also cancel. Cancellation closes the view immediately and rejects late results. Native decoding already in progress may finish within its bounded processing time before the operation slot is released. Interrupted previews are never retried automatically. Reopen explicitly after reconnecting or fixing a file.

## Privacy and safety

Only allowed raster signatures reach the decoder. It reads a buffer, limits pixels, decodes the first frame, applies orientation and produces a fresh PNG without original EXIF/XMP metadata or trailing content. The renderer receives only that display copy through a validated, session-bound IPC operation. It does not render original image bytes as a document or load document URLs. The existing renderer sandbox, context isolation and network restrictions remain enabled.

No local preview files or recovery backups are created, and remote bytes/permissions are unchanged. Decoder caching is disabled. Closing the dialog releases its display data; SSH/SFTP loss and idle protection remove the preview. Memory release is not guaranteed secure erasure: the operating system can retain process memory or paging data. File contents are not logged or stored as preferences.

Native decoder packaging and actual-device behavior require validation on Windows, Linux and both macOS architectures. The source is an alpha preview; passing Windows checks does not certify the other platforms. Multiple image/editor tabs remain planned.

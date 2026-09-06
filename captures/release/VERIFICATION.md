# Cloudbreak release capture and verification

The finished demonstration is 87.5 seconds, with 2,100 frames at 3840 by 2160 and 24 frames per second. The high-quality master and the compressed 4K README copy both passed complete video and audio decoding, duration, frame-count and fast-start checks. [Download the high-quality 4K master](https://github.com/JarthurLabs/cloudbreak/releases/download/v0.1.0/Cloudbreak-4k-Demo.mp4), or use [the compressed inline player in the README](../../README.md).

The master is 52,508,020 bytes. Its SHA-256 is `f1a53fb5af5c222cf1d981468c9e3c64702c7a5a1f10c1a107bc5667d75523bd`. The inline copy is 9,005,226 bytes, with SHA-256 `700b790e6032150d39f85918366662599e258ee16128052c32155508958d78bf`. It preserves the same edit, dimensions and frame count with lower audio and video bitrates. The inline copy is a convenient preview; the master preserves more detail.

## Actual normal-time mission

The capture ran the existing First Light mission in an isolated local browser and gateway. It used the default real clock, ordinary pointer controls, and three-second reactions to the authored waves. No clock values, request outcomes, score, traffic actors or audio events were injected.

The mission ran for 180 active seconds and 180.2 wall-clock seconds. It finished with 80.9 integrity and 902 of 1,056 customers served, or 85.4167 percent. It passed the 75-percent service target. The 1,946 completed HTTP records reconcile with the counters: 762 hostile requests were rejected and 128 were admitted. Recorded damage totals 19.1. Browser errors were empty.

These are results from one local demonstration. They do not establish public hosting latency, capacity, or the result a new player will achieve. The release has 53 passing automated tests, including the 46 existing gameplay checks and seven hosting checks. GitHub's clean continuous-integration run passed on [release revision d1d1ef5](https://github.com/JarthurLabs/cloudbreak/commit/d1d1ef5d76ab377f720fd7ed3379a57cb0d65b15). [The hosting notes](../../docs/HOSTING.md) explain the local checks.

## Separate public browser review

The [public game](https://cloudbreak.onrender.com/) passed an independent full-mission browser review on September 6, 2026. The release task confirmed revision d1d1ef5 in Render's deployment interface before the run. The game health response does not expose that commit identifier.

The public run used the unmodified server clock, ordinary pointer controls and actual API responses. It completed 180 mission seconds, winning with 79.1 integrity and 918 of 1,071 customers served, or 85.7143 percent. Its 1,964 completed HTTP records reconciled with the counters: 768 hostile requests were rejected and 125 were admitted. Browser errors were empty. This is a separate run from the 80.9-integrity mission shown in the film.

Independent browser contexts received separate owner cookies and sessions. Cross-cookie access to the other mission was rejected. The public background and Firewall Drive asset hashes matched the approved files. Actual audio was captured at the browser speaker output after the master gain and limiter: music was present, mute produced near-silence, and unmute restored the signal, without clipping. These are technical signal checks, not a subjective listening review.

[The sanitized public review receipt](public-check/report.json) retains those measurements. No public cold start was measured, and no long-duration, worldwide, or simultaneous-user capacity claim follows from this review. Local expired-session recovery checks are documented separately in [the hosting guide](../../docs/HOSTING.md).

## Native resolution and capture limits

The browser viewport and game canvas were both 3840 by 2160, with a device pixel ratio of one. Gameplay was rendered at that resolution. For the capture, the main interface was scaled to twice its normal CSS size so the warning, timer and controls would remain legible in a 4K demonstration. This was a presentation adjustment, not a change to game state or gameplay geometry.

The complete source spans about 199.46 seconds, including the briefing and post-flight views. It contains 4,001 stored compositor frames at an average of 20.06 frames per second. Source timestamps are variable, and the longest interval between captured frames is about 1.65 seconds. Review-screenshot capture introduced visible holds in that source stream while the mission continued. A 4K pixel dimension does not imply a constant 60-frame-per-second recording.

The finished film uses normal-speed passages and excludes the screenshot-related holds through ordinary editorial cuts. The longest source frame interval within a selected gameplay excerpt is about 79 milliseconds. The final 24-frame-per-second presentation holds or drops original frames according to their timestamps; it does not invent intermediate motion or speed up gameplay. Separately drawn introduction and closing graphics are editorial additions, clearly distinguished from the running game. [Exact edit decisions](film-edit.json) retain the source intervals and captions.

The gameplay audio comes from the game's live post-master audio graph, with the selected **Firewall Drive** loop and separate game effects. The title and closing cards use the same original loop, matched to the captured music level. A constant gain sets the demonstration level, and short fades at cuts avoid clicks. The master mix measures minus 20.02 integrated LUFS and minus 4.71 decibels true peak. Complete decoded-audio checks found no clipped or non-finite samples and no unintended quarter-second silence. [Film provenance and limits](FILM.md) describe the mix and the compressed copy. The source recording and unsanitized operational reports remain local.

## README images

[City online](01-city-online-4k.webp) and [two simultaneous fronts](02-two-fronts-4k.webp) are full-frame WebP copies of the corresponding native 4K gameplay screenshots. They are 1920 by 1080, encoded at quality 85 with Lanczos resizing. No content was cropped, replaced, redrawn or rearranged. The controls, warnings and traffic were inspected at normal reading size and remain clear.

[Detail from the actual post-flight Inspect panel](05-request-evidence-detail.webp) is an honest crop from the original 3840 by 2160 evidence screenshot. Its source rectangle begins at x 3410, y 10, with width 420 and height 876. It is encoded at quality 85 without resizing or replacing any text. The caption is **“Detail from actual post-flight Inspect panel.”** The customer count, rejected and admitted totals, explanatory copy, and the first request rows are readable in this detail. The full-frame original is preserved locally.

The full-frame evidence export made the panel's small text difficult to read because that panel was not part of the interface scaling. Using the labelled detail preserves the actual evidence while making it practical to inspect in the README. It is a screenshot detail, not a new gameplay event or a native 4K panel image.

All three selected public WebP images are below 400 kilobytes each. Their exact source and output hashes are retained in the publication manifest. Visual review here means inspection of actual sampled frames and screenshots; it is not a claim of continuous-video artistic acceptance or measured learning effectiveness.

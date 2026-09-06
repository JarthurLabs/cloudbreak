# Cloudbreak release capture and verification

The native 4K gameplay source and the selected README screenshots have been captured and checked. The finished demonstration is still being edited. Its final duration, edit decisions, soundtrack mix, file hash, complete decode and public attachment remain pending; this document does not yet certify a finished film.

## Actual normal-time mission

The capture ran the existing First Light mission in an isolated local browser and gateway. It used the default real clock, ordinary pointer controls, and three-second reactions to the authored waves. No clock values, request outcomes, score, traffic actors or audio events were injected.

The mission ran for 180 active seconds and 180.2 wall-clock seconds. It finished with 80.9 integrity and 902 of 1,056 customers served, or 85.4167 percent. It passed the 75-percent service target. The 1,946 completed HTTP records reconcile with the counters: 762 hostile requests were rejected and 128 were admitted. Recorded damage totals 19.1. Browser errors were empty.

These are results from one local demonstration. They do not establish public hosting latency, capacity, or the result a new player will achieve. The current local release checks report 53 passing automated tests, including the 46 existing gameplay checks and seven hosting checks. [The hosting notes](../../docs/HOSTING.md) explain their scope. Public deployment and continuous-integration results are separate release checks.

## Native resolution and capture limits

The browser viewport and game canvas were both 3840 by 2160, with a device pixel ratio of one. Gameplay was rendered at that resolution. For the capture, the main interface was scaled to twice its normal CSS size so the warning, timer and controls would remain legible in a 4K demonstration. This was a presentation adjustment, not a change to game state or gameplay geometry.

The complete source spans about 199.46 seconds, including the briefing and post-flight views. It contains 4,001 stored compositor frames at an average of 20.06 frames per second. Source timestamps are variable, and the longest interval between captured frames is about 1.65 seconds. Review-screenshot capture introduced visible holds in that source stream while the mission continued. A 4K pixel dimension does not imply a constant 60-frame-per-second recording.

The film is being edited from normal-speed passages, avoiding those source capture holds. The completed edit will distinguish actual gameplay from the separately drawn introductory and closing graphics. An enlarged detail crop must be identified as a crop rather than presented as native 4K detail. Final edit timing and media checks will be added after export.

The source audio came from the game's live post-master audio graph, with the selected **Firewall Drive** loop and separate game effects. Final-film audio assembly and synchronization are still being checked. The source recording and unsanitized operational reports remain local.

## README images

[City online](01-city-online-4k.webp) and [two simultaneous fronts](02-two-fronts-4k.webp) are full-frame WebP copies of the corresponding native 4K gameplay screenshots. They are 1920 by 1080, encoded at quality 85 with Lanczos resizing. No content was cropped, replaced, redrawn or rearranged. The controls, warnings and traffic were inspected at normal reading size and remain clear.

[Detail from the actual post-flight Inspect panel](05-request-evidence-detail.webp) is an honest crop from the original 3840 by 2160 evidence screenshot. Its source rectangle begins at x 3410, y 10, with width 420 and height 876. It is encoded at quality 85 without resizing or replacing any text. The caption is **“Detail from actual post-flight Inspect panel.”** The customer count, rejected and admitted totals, explanatory copy, and the first request rows are readable in this detail. The full-frame original is preserved locally.

The full-frame evidence export made the panel's small text difficult to read because that panel was not part of the interface scaling. Using the labelled detail preserves the actual evidence while making it practical to inspect in the README. It is a screenshot detail, not a new gameplay event or a native 4K panel image.

All three selected public WebP images are below 400 kilobytes each. Their exact source and output hashes are retained in the publication manifest. Visual review here means inspection of actual sampled frames and screenshots; it is not a claim of continuous-video artistic acceptance or measured learning effectiveness.

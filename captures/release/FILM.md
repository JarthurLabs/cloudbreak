# Cloudbreak — 4K demonstration

The film is an 87.5-second educational edit of one actual First Light mission. It shows why protecting cloud services requires balancing access controls with availability. The finished mission ran for 180.2 seconds of real wall-clock time; its result was 80.9 integrity, 85.4 percent of legitimate requests served, and 762 threats blocked.

The opening explains that legitimate users and attacks share the same public connection. Real gameplay then shows authentication, a rate limit shared by customers and attackers, full route isolation, reopening after an attack, and simultaneous defenses across three services. It ends with the actual victory screen, request evidence and an invitation to play.

[Download the high-quality 4K master](https://github.com/JarthurLabs/cloudbreak/releases/download/v0.1.0/Cloudbreak-4k-Demo.mp4) · [Watch the compressed 4K inline player](../../README.md)

A separate compressed 4K README attachment is 9.01 megabytes. It retains the native 3840 by 2160 dimensions, all 2,100 frames, normal playback speed and the same captions. Its reduced bitrate makes it suitable for the README upload interface, which rejected the master because of its ten-megabyte attachment limit. The 52.51-megabyte master remains the preferred high-quality version and is linked alongside the inline player. The inline copy has lower audio and video bitrates; it does not preserve the master's fine detail or compression quality.

The small attachment passed complete video and audio decode, duration, frame count, file-size and fast-start checks. Selected caption and gameplay frames were inspected at 1280 and 1920 pixels wide: the main teaching text, percentage signs, control labels and enemy silhouettes remain readable. This is sampled-frame review, not a continuous human review of its motion. Its complete verification receipt and encoding recipe are retained locally. [The public verification summary](VERIFICATION.md) records the exact size, hash and review limits.

An optional 1080p viewing copy was also produced locally. It passed a complete decode of all 2,100 frames and preserves the exact AAC audio payload of the 4K master. The public README uses the 4K copies described above.

## What is real and what is editorial

The gameplay excerpts are actual Chrome compositor frames from a native 3840 by 2160 canvas and viewport. The capture used larger interface typography for legibility. No gameplay state, request outcomes, traffic actors or sound-effect events were injected for the recording. The captions and opening and closing motion cards are explicitly editorial additions. The illustrations are original, separately rendered graphics.

Every gameplay excerpt plays at normal speed and retains its simultaneously recorded music and effects. The game runs actual HTTP requests through its own gateway; its workload, visible threat labels and city damage are authored teaching devices. They do not represent a production cloud deployment or an attack against an external target.

The final presentation uses 24 frames per second. The original compositor recording had variable cadence, averaging about 20 stored frames per second across the full capture. The edit holds or drops original frames according to their real timestamps; it does not invent intermediate motion. The longest original frame interval within the selected excerpts is approximately 79 milliseconds. The larger screenshot-related holds elsewhere in the source were excluded through ordinary cuts.

The actual results and request-evidence panels retain their captured layout. Their small individual rows are not intended to be read from a full-frame mobile video. Large film captions explain what they establish; the repository's screenshot details provide a closer view.

## Audio

Nicholas selected Firewall Drive from five original urgent-score auditions. The game uses a seamless 124-beat-per-minute rendering of that selected recipe. Gameplay in this film keeps the real captured mix. The title and closing cards use the same original loop, matched to the recorded soundtrack level. One constant gain raises the complete edit to a comfortable demonstration level. Brief fades at cuts avoid clicks; there is no narration or fabricated gameplay audio.

The final mix measures minus 20.02 integrated LUFS and minus 4.71 decibels true peak. Complete decoded-audio checks found no clipped or non-finite samples and no unintended quarter-second silence.

## Verification and reproducibility

The final 4K file is H.264 High profile with stereo AAC audio in an MP4 container. It contains 2,100 video frames, measures 52,508,020 bytes, and has its playback metadata before the media data for progressive loading. Every video frame and the complete audio stream decoded successfully. The decoded audio lasts 87.509 seconds because of audio-container granularity.

SHA-256: `f1a53fb5af5c222cf1d981468c9e3c64702c7a5a1f10c1a107bc5667d75523bd`

[Exact edit decisions and source provenance](film-edit.json) · [Public verification summary](VERIFICATION.md) · [Actual Inspect-panel detail](05-request-evidence-detail.webp)

The edit recipe and complete verification scripts require the original local capture assets and remain in the local production workspace. Raw frames, the full unedited recording, contact sheets and private operational receipts are kept outside the public release. The public edit receipt retains the timing, captions and source hashes. Its repository-relative raw paths identify local provenance; they are not download links. It contains no personal absolute paths or session credentials.

Sampled-frame inspection confirmed the large captions, their placement, the control views and both motion cards. This is distinct from a continuous human audiovisual review of the complete film.

## What needed correction

Taking large screenshots during recording briefly stopped compositor updates. The affected intervals were identified from the captured timestamps and cut out without speeding up gameplay or inventing frames. A second issue appeared only during visual review: the text renderer interpreted percentage signs and suppressed two caption lines. Literal text rendering fixed both lines, and the corrected export passed the complete decode and audio checks again.

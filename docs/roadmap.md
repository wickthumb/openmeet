# First prototype roadmap

The initial milestones below were recorded on October 26, 2026. See the [working demo walkthrough](demo-script.md) and [desktop instructions](../app/README.md) for current implemented behavior; unchecked acceptance items and the later sections remain planned work.

## 1. Finish evidence and manual review

- [ ] Select representative sprint and distance finish footage with permission to use it.
- [ ] Document the camera/image format and hardware timestamp mapping.
- [ ] Load a race roster and preserve evidence references.
- [ ] Support manual finish marks and identity corrections.
- [ ] Separate proposed, reviewed, and officially approved results.

## 2. Proprietary vision API integration

- [ ] Build and evaluate the custom finish-detection model outside this public repository.
- [ ] Implement the separate inference service.
- [ ] Finalize the API contract and implement an OpenMeet adapter.
- [ ] Display proposed sprint marks and lane associations over the original evidence.
- [ ] Preserve a manual review path when inference is unavailable.

## 3. Meta-assisted distance identification

- [ ] Add tools for retrieving relevant frames and checking race entries.
- [ ] Integrate a Meta vision model through the configured inference provider.
- [ ] Show candidate bib/roster matches with supporting evidence.
- [ ] Keep ambiguous identities unresolved until the official reviews them.
- [ ] Record proposed matches, corrections, and confirmations.

## 4. Demonstration and verification

- [ ] Demonstrate one sprint finish through official approval.
- [ ] Demonstrate one distance identity resolved using real supporting footage.
- [ ] Check results against a known reference and record actual corrections.
- [ ] Measure processing/review time before making speed claims.
- [ ] Record the three-minute demo using the working prototype.
- [ ] Document which features were built during the hackathon and which remain planned.

## Longer-term product direction

Expand toward a complete open-source photo-finish and meet-operations application: more race formats, dependable hardware integration, resilient operation, interoperability, and a simpler workflow for meet operators.

## Continuous line-scan compression research

Research only; no continuous-recording format or archive-quality settings are implemented yet. Storage targets are operator choices, not a fixed 10 GB requirement. Compare native lossless, near-lossless, saved spatial crop, vertical resizing, and runner/guide derivatives with a separate native per-race archive. An exact correction layer can preserve original bytes independently of mask accuracy, but must be measured for total storage cost.

Account for each camera’s native height (including 1000/2000+ rows), columns per second, channel depth/packing and clock, rather than transferring a demo compression ratio to higher-end modes. Spatial options must keep the original time columns and timestamps, with explicit source-row origin, scale, filter and recipe version. Display Frame height/Zoom stays separate from saved archive settings.

Before applying or exporting a quality recipe, show synchronized original and decoded previews, pixel-level inspection, excluded rows, measured sample bytes and conditional size estimates. Native per-race recording is independently controlled by arming/start triggers and operator stop, with explicit pre/post coverage; runner detection must not decide whether source evidence exists. Overlapping races/restarts can reference shared native chunks. A smaller derivative alone cannot restore omitted runner pixels or lane paint.

Qualification still needs representative real camera noise, lighting changes, crowded finishes, sustained throughput, source gap accounting, exact clocks, random access and crash recovery. Short simulated codec tests and perfect finite mask tests cannot establish real-camera full-day capacity or a never-missed-runner guarantee.

Compare tight foreground masks with padded detection rectangles and full-height time windows. A tight outline can omit real athlete pixels; larger retained regions trade some background savings for more context. Padding must account for sensor resolution and scan rate. Measure independently labelled body pixels, torso edges and complete missed runners separately: exact compression of a selected region does not prove that selection retained every athlete.

Explore one logical meet recording with an indexed start-trigger journal and race views referencing its columns, so a heat can use a different start without rewriting the original evidence. Keep proprietary models separate. Any storage or timing claim needs measured results and a real-camera validation plan.

## Optional custom line-scan background

A first pass is available in **Camera setup → Billboards**, with a **⋯ → Billboards** shortcut on the scan: multiple repeating bands, the shared OpenMeet logo and meet name, static SVG import, and a local coding-agent asset library. See [billboard-v1.md](billboard-v1.md) for placement, masking, verification and remaining limits. Animated designs and independent real-camera accuracy/performance validation remain future work.

A stationary line-scan scene repeats nearly the same column over time. Estimate that scene from empty-track columns, allowing for sensor noise, shadows, sun and cloud changes. Separate passing athletes from the baseline and optionally show a custom design behind them.

- An operator toggle keeps the original view as the default and available instantly.
- Offer a library and AI editing workflow similar to the scoreboard editor: meet titles, Track Tools Pro artwork, sponsor designs, or animated billboards across the time axis.
- Preserve the original capture and timestamps. Render replacement backgrounds only in the display; timing marks, evidence exports and proprietary model requests continue to reference original pixels.
- Define how artwork maps to captured column time, so scrolling, zooming and replay produce a stable design.
- Evaluate foreground separation on bodies, limbs, overlapping runners, lane lines, shadows and gradual or sudden lighting changes. Show the original image whenever separation is uncertain.
- Any proprietary segmentation or cropping model remains in a separate service; this public app contains only its API client and display integration.

Acceptance: with the option disabled, capture and review remain unchanged; with it enabled, finish columns and saved times remain identical. Background design is presentation, never replacement timing evidence.

## Guided hardware setup and verification

Planned for a later integration phase; see [the hardware setup blueprint](blueprint.md#11-guided-hardware-setup-with-ai-assistance).

- [ ] Define a common engine adapter and device-profile contract for scoreboards, cameras, start sensors and wind gauges.
- [ ] Select exact Daktronics scoreboard/controller and FinishLynx camera models for the first prebuilt integrations; research their official documentation and available driver/protocol interfaces.
- [ ] Add novice-friendly setup from Scoreboard and Network, with manual model selection or photo-assisted identification.
- [ ] Add an AI assistant that researches matching manuals and uses supported discovery/configuration/diagnostic tools.
- [ ] Verify a physical scoreboard with a distinctive test pattern, a running clock and explicit operator confirmation.
- [ ] Verify camera discovery, received images, stored capture and start/timestamp alignment as separate capabilities.
- [ ] Save working profiles and source-backed setup instructions for reuse.
- [ ] Keep unknown equipment unverified until its adapter passes actual hardware tests; provide a specification/draft path for adding support.

## Camera inventory, movable setups and recording all views

Planned engine/UI work; the current replay engine records one active stream. See [camera identity and race views](blueprint.md#camera-identity-positions-and-race-views-planned).

- [ ] Give every device a stable identity, independent of main/additional viewing roles.
- [ ] Define named finish locations with inside/outside or custom camera positions. Bind the heat to its finish location instead of deriving it from event distance.
- [ ] Keep a versioned, timestamped placement/calibration history when a camera moves, changes direction or changes sensor mode. Earlier recordings retain their original setup.
- [ ] Record every connected/enabled camera during meet recording, regardless of the selected view or the finish location currently in use. Report each recorder's actual state, gaps and clock health.
- [ ] Select the heat's timing camera separately from other review views. Offer cameras at the same finish first; label other finish locations clearly and avoid automatic timing comparisons across unrelated finishes.
- [ ] Support a single camera moved between races: select its new location, align/check it, and use that setup for following heats without rewriting earlier work. Mark mid-race setup changes for review while preserving recording.
- [ ] Verify shared starts, per-camera clocks, simultaneous throughput and aggregate storage before claiming reliable multi-camera timing or full-day capacity.

## Optional meet records and athlete images

Planned work, not implemented. Keep **Meet → Records** optional: an operator can run the meet without configuring records.

- [ ] Enter existing records by event/category, with optional holder and date.
- [ ] Flag a potential record during finish review, then let the operator confirm it against the accepted result and any applicable eligibility conditions before updating the record.
- [ ] Optionally display **Meet record** in that athlete's lane, behind the runner using the occlusion layer. This is a lane-specific celebration rather than a repeating billboard.
- [ ] Create a separate athlete image/meet keepsake with the record annotation, athlete, official mark and meet context. A later hosted-results feature could attach it to the result.
- [ ] Preserve the original recording, timestamps and timing evidence. Decoration and image export remain optional derivatives; proprietary masks stay in their separate service.

Across Meet, Records and the other setup dialogs, organize around the operator's next task: a clear default path, plain labels, and optional or advanced tools revealed when needed. Keep live timing controls immediately available to experienced coaches without making first-time operators read technical settings.

# First prototype roadmap

All items below are planned work. This initial repository establishes the project baseline on October 26, 2026.

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

## Optional custom line-scan background

Requested for a later iteration; not implemented yet.

A stationary line-scan scene repeats nearly the same column over time. Estimate that scene from empty-track columns, allowing for sensor noise, shadows, sun and cloud changes. Separate passing athletes from the baseline and optionally show a custom design behind them.

- An operator toggle keeps the original view as the default and available instantly.
- Offer a library and AI editing workflow similar to the scoreboard editor: meet titles, Track Tools Pro artwork, sponsor designs, or animated billboards across the time axis.
- Preserve the original capture and timestamps. Render replacement backgrounds only in the display; timing marks, evidence exports and proprietary model requests continue to reference original pixels.
- Define how artwork maps to captured column time, so scrolling, zooming and replay produce a stable design.
- Evaluate foreground separation on bodies, limbs, overlapping runners, lane lines, shadows and gradual or sudden lighting changes. Show the original image whenever separation is uncertain.
- Any proprietary segmentation or cropping model remains in a separate service; this public app contains only its API client and display integration.

Acceptance: with the option disabled, capture and review remain unchanged; with it enabled, finish columns and saved times remain identical. Background design is presentation, never replacement timing evidence.

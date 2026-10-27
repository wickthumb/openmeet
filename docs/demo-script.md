# Proposed three-minute demo

Working title: **Can AI Untangle This Race Finish?**

This script describes the target prototype. Record each action only once it works. Use a real distance finish where another frame supplies the missing bib evidence, and replace the bracketed bib number with the actual value. Identify recorded footage as a replay and label any time compression.

## 0:00–0:15 — The challenge

Screen: show the sprint, then freeze the crowded distance finish on the obscured bib.

> I'm giving OpenMeet two race finishes: this sprint—and this distance finish, where we can't read a runner's bib.
>
> Can we get both to results an official can approve?

## 0:15–0:30 — The setup

Screen: keep the race footage visible. Add progress indicators for Sprint and Distance.

> OpenMeet is open source. It calls our proprietary finish-detection model through an API, then uses a Meta-powered agent to help identify runners.
>
> The official makes the final call.

## 0:30–1:00 — Custom model

Screen: run the sprint. Briefly show OpenMeet → proprietary model API → proposed finish marks, then enlarge the marks.

> First, the sprint. We know who's in each lane.
>
> OpenMeet sends the finish image to our model API. The model runs on our server and returns proposed finish marks. Its weights stay on the server.
>
> Here are those marks over the original image, linked to the recorded hardware timestamps.
>
> I inspect them, adjust anything necessary, and approve the heat.
>
> One race approved.

## 1:00–1:15 — The harder case

Screen: return to the unidentified distance runner from the opening.

> Now take away the assigned lanes.
>
> The model has marked the finishes. But this runner's identity is still missing.
>
> We have a measured time. We still need the athlete.

## 1:15–1:50 — Meta agent

Screen: show nearby frame crops, visible bib details, and roster candidates beside the finish evidence.

> I ask the Meta-powered agent to help resolve this finisher.
>
> It retrieves nearby frames, examines the visible bib details, and checks the race roster.
>
> OpenMeet brings the supporting images and candidate entries into the official's review.
>
> But this view still doesn't provide enough evidence. The identity stays unresolved.
>
> Let's look earlier.

## 1:50–2:20 — The reveal

Screen: the official requests an earlier view. Show the clearer frame beside the obscured one.

> Show me the clearest earlier bib view.
>
> There—now we can read it.
>
> The Meta agent extracts [actual bib number] and checks the roster.
>
> Here's the proposed athlete, alongside the image supporting that match.
>
> I check the evidence and confirm the identity.

Pause so viewers can read the bib and matching entry.

## 2:20–2:45 — Official control

Screen: show the confirmed athlete attached to the original finish mark. Open the evidence record, then approve the reviewed results.

> The official controls that confirmation. I can correct the suggestion or leave the identity unresolved.
>
> The measured time remains tied to the original hardware timestamp. The supporting evidence and review decision remain attached to the result.
>
> This match checks out. I'm approving the reviewed distance results.

## 2:45–3:00 — The payoff

Screen: show both approved result sets, then transition to the next heat.

> Two finishes. Both approved. The evidence is preserved, and we're ready for the next heat.
>
> That's OpenMeet: specialized vision, a Meta-powered assistant, and an official in control—keeping the meet moving.

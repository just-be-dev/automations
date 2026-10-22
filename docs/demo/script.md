# Demo script

This is the live part of the talk, act two in the [deck](deck/index.html) (`mise run slides`). You dictate every request to the studio agent. Each step lists what to do, where to click, and what the audience should notice.

## Before going on stage

1. In `.env`, set `DEMO_GRACE_EMAIL` and `DEV_USER_EMAIL` to your own address. With Slack connected, use your Slack sandbox account's address. See [Demo addresses](../development.md#demo-addresses).
2. Run `mise run dev`, then `mise run demo:reset` in a second terminal. Keep the fallback link the reset prints (`/?automation=first-week`).
3. Open the studio. In the assistant panel, press **New thread** so the panel starts empty.
4. Press **Start dictation** (the microphone next to Send) once and allow microphone access, then press **Cancel dictation**. You don't want the browser's permission prompt on stage.
5. If Slack is connected, open Slack as yourself (Grace) beside the browser.

## 1. Describe the job

1. In the sidebar, press **New automation** (+). The assistant opens on a new thread with "Draft an automation that " already in the composer. Clear it, since you'll dictate the whole request.
2. Press **Start dictation** and say:

   > When someone new joins, welcome them on Slack, send our welcome email, and book 30 minutes with their manager. Three days in, check how it's going.

3. Press **Stop dictation**. Wait for the words to stop changing, fix any mistakes in the input, then press **Send**.
4. The agent asks something like: _Should someone review the welcome email before it goes out?_ Choose the answer that has each one approved first, then press **Send answers**.

**Point out:** the agent asks about a real choice before it drafts anything. While it works, the studio page shows what the planner is doing.

## 2. Read the plan

The draft appears in the studio: **Launch a great first week**. Walk it top to bottom:

- The trigger: an employee's start date.
- **Get the first day ready**: three branches that run at the same time (find a welcome slot, give the manager a heads-up, and welcome them on Slack).
- **Send the right welcome email**: the template is chosen by role, and the step shows _Asks first_.
- **Book their first conversation**, **Give them three days to settle in**, **Ask the manager how it's going**.

**Point out branch three.** If the planner picked `#general`, this is the act one mistake, and here you see it before it reaches anyone. If it picked something else, say what it chose and make the same correction anyway.

## 3. Change one thing by talking

1. Press **Start dictation** and say:

   > Not #general, their start isn't announced yet. Welcome engineers in #eng-team instead.

2. Press **Stop dictation**, check the text, and press **Send**.
3. The branch now reads **Welcome them in #eng-team**, marked **Changed**.

**Point out:** the planner changed one step, and the mark shows exactly what moved.

Optional, if you have time and want the check-in to collect specific answers:

> For the check-in, ask the manager who their buddy is, what they're working on, and whether they need any help.

## 4. Permissions

Scroll to **Permissions**. Each operation lists the steps that use it. **Send an email** is set to **Ask first**; the others are set to **Allow**.

**Point out:** permissions belong to this plan's operations, so someone approves this specific message rather than "email" in general.

## 5. Save and run on Ada

1. Press **Save draft**.
2. Pick **Ada Lovelace** in the employee picker beside the run button, then press **Run saved version**.
3. The run opens beside the workflow, one row per step. The three branches finish, and **Send the right welcome email** waits for approval.

**Point out:** runs use the saved version, so you can keep editing the draft without touching this run.

## 6. Approve the email

Press **Approve** on the task in the run panel. It shows the finished engineering welcome email.

The step then reads _Approved by_ your address, with the time. If Slack is connected, show the heads-up DM and the `#eng-team` post. Email and Calendar are simulated, so say so when you show their results.

## 7. Skip ahead three days

On **Give them three days to settle in**, press **Resume now** (it's labelled _Local dev only_). The check-in task opens. Fill in the manager's answers and press **Submit**.

**Point out:** the answers stay on the run. Then click **Send the right welcome email** in the run to show what you'd look at weeks later: the branch it took, the template, who approved it and when, and what it sent.

## If something goes wrong

- **The planner misbehaves or a Workers AI call is slow:** open `/?automation=first-week` from the reset. It's the plan after the `#eng-team` edit, already saved. Continue from step 5.
- **Dictation garbles the request:** edit the text in the input before pressing Send, or type it.
- **The agent stalls:** press **Stop** (it replaces Send while the agent works). The draft stays as it was. Then retry or switch to the fallback.
- **Between rehearsals:** run `mise run demo:reset` again and press **New thread**.

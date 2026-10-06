/** Resolves the browser-only dialog effects in confirmation tests. */
import { Animation, Dialog } from "@foldkit/ui";

export const openedResolvers = () =>
  [
    [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
    [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })],
    [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })],
  ] as const;
export const closedResolvers = () =>
  [
    [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 2 })],
    [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 2 })],
    [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()],
  ] as const;

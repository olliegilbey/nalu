"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { t } from "@/i18n";

/** Return shape of {@link useCustomInstructions}: the saved text and a save action. */
export interface UseCustomInstructionsResult {
  /** The saved text; null when none is set; undefined until the read lands. */
  readonly saved: string | null | undefined;
  /** True when the read failed after its retries. */
  readonly loadFailed: boolean;
  /** True while a save is in flight. */
  readonly isSaving: boolean;
  /** Save the text as typed. The server trims it; empty clears the preference. */
  readonly save: (text: string) => void;
}

/**
 * Read and save the learner's custom instructions for the settings sheet.
 *
 * The read runs only while `open` is true, so pages that never open the sheet
 * never fetch it. A successful save toasts and refetches the read, so the
 * sheet shows the value the server stored. A failed save toasts the error.
 */
export function useCustomInstructions(open: boolean): UseCustomInstructionsResult {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const readOpts = trpc.profile.getCustomInstructions.queryOptions(undefined, { enabled: open });
  const read = useQuery(readOpts);

  const write = useMutation(
    trpc.profile.setCustomInstructions.mutationOptions({
      // Returns the invalidation promise, so the save stays pending until the
      // refetched value lands.
      onSuccess: () => {
        toast.success(t("settings.saved"));
        return qc.invalidateQueries({ queryKey: readOpts.queryKey });
      },
      onError: (err) => {
        toast.error(t("settings.saveFailed"), { description: formatMutationError(err) });
      },
    }),
  );

  return {
    saved: read.data?.customInstructions,
    loadFailed: read.isError,
    isSaving: write.isPending,
    save: (text) => write.mutate({ customInstructions: text }),
  };
}

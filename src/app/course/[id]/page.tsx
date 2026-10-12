import { notFound } from "next/navigation";
import { z } from "zod";
import { Onboarding } from "@/components/chat/Onboarding";

/**
 * `/course/[id]` route — mounts the scoping `Onboarding` chat for the course.
 * Next 16's `params` is a Promise; awaited once so the client component sees
 * a plain string.
 */
export default async function CoursePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  // A malformed id fails `course.getState` input validation (BAD_REQUEST), so
  // the chat would retry, then sit empty. `notFound()` throws: Next renders
  // the not-found boundary with a real HTTP 404, as the wave page does.
  if (!z.uuid().safeParse(id).success) notFound();
  return <Onboarding courseId={id} />;
}

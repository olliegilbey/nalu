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
  return <Onboarding courseId={id} />;
}

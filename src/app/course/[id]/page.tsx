import { Onboarding } from "@/components/chat/Onboarding";

export default async function CoursePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  return <Onboarding courseId={id} />;
}

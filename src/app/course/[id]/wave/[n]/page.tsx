export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly n: string }>;
}) {
  const { n } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-kanagawa-atmos text-foreground">
      <div className="text-center px-6">
        <h1 className="text-[28px] font-medium tracking-tight">Wave {n} coming soon</h1>
        <p className="mt-3 text-fuji-gray text-[14px]">The teaching loop ships in a follow-up.</p>
      </div>
    </main>
  );
}

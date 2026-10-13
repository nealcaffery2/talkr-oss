import { SoftphoneProvider } from '@/lib/softphone';
import { CallBar } from '@/components/CallBar';
import { WrapUp } from '@/components/WrapUp';
import { IncomingCall } from '@/components/IncomingCall';
import { RailNav } from '@/components/RailNav';

/**
 * The workspace shell (design 1c): a fixed icon rail beside a single scrolling
 * column. On a phone the rail becomes a tab bar under the column (RailNav
 * decides which it is). The softphone provider wraps everything and is
 * mounted exactly once, so navigating between pages never drops a live call.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SoftphoneProvider>
      <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
        <RailNav />
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <CallBar />
      <WrapUp />
      <IncomingCall />
    </SoftphoneProvider>
  );
}

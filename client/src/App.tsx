import { useSyncExternalStore } from 'react';

import { SignIn } from './components/SignIn';
import { Shell } from './components/Shell';
import { getSession, subscribe } from './state/sessionState';

export default function App() {
  const session = useSyncExternalStore(subscribe, getSession);

  if (!session) {
    return <SignIn />;
  }

  return <Shell address={session.address} />;
}

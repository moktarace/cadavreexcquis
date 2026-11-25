import { Suspense, lazy } from 'react';
import { GameProvider } from './app/game';
import { hrefOf, useRoute, type Route } from './app/router';
import { useOnline } from './app/hooks';
import { RepliesProvider, useReplies } from './app/replies';
import { RewardsProvider, useRewards } from './app/rewards';
import { EditorScreen } from './editor/ui/EditorScreen';
import { CasePage, StoryPage, TreePage } from './pages/Browse';
import { BrowsePage } from './pages/Continue';
import { PlayPage } from './pages/Play';
import { PublishedPage } from './pages/Published';
import { ReplyPage } from './pages/Reply';
import { FinishedPage } from './pages/Rewards';
import { HomePage } from './pages/Home';
import { ReadPage } from './pages/Read';
import { ArchivesPage, MinePage, WeekPage } from './pages/Library';
import { AdminPage } from './pages/Admin';
import { SettingsPage } from './pages/Settings';
import { Dock, type DockItem } from './ui';

// Chargé à part: le laboratoire n'alourdit pas le jeu et n'a aucun lien dans la navigation.
const SurvivorPage = lazy(() => import('./survivor/SurvivorPage'));

interface NavEntry {
  id: string;
  label: string;
  icon: DockItem['icon'];
  route: Route;
  active: Route['name'][];
}

/** Trois entrées: Jouer (au centre, l'action principale), Lire, Mes dessins. */
const PLAY: NavEntry = { id: 'play', label: 'Jouer', icon: 'pencil', route: { name: 'play', startId: null }, active: ['play', 'browse'] };
const SIDES: NavEntry[] = [
  { id: 'read', label: 'Lire', icon: 'book', route: { name: 'read' }, active: ['read', 'archives', 'week', 'case', 'story', 'tree'] },
  { id: 'mine', label: 'Mes dessins', icon: 'star', route: { name: 'mine' }, active: ['mine', 'reply', 'finished'] },
];
const toItem = (n: NavEntry, current: Route['name'], badge = false): DockItem => ({ id: n.id, label: n.label, icon: n.icon, href: hrefOf(n.route), active: n.active.includes(current), badge });

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'play':
      return <PlayPage key={route.startId ?? 'any'} startId={route.startId} />;
    case 'browse':
      return <BrowsePage />;
    case 'read':
      return <ReadPage />;
    case 'published':
      return <PublishedPage id={route.id} />;
    case 'case':
      return <CasePage id={route.id} />;
    case 'reply':
      return <ReplyPage id={route.id} />;
    case 'finished':
      return <FinishedPage id={route.id} />;
    case 'story':
      return <StoryPage id={route.id} />;
    case 'tree':
      return <TreePage id={route.id} />;
    case 'mine':
      return <MinePage />;
    case 'archives':
      return <ArchivesPage />;
    case 'week':
      return <WeekPage id={route.id} />;
    case 'settings':
      return <SettingsPage />;
    case 'admin':
      return <AdminPage />;
    case 'draw':
    case 'survivor':
      return null;
  }
}

function Screens() {
  const route = useRoute();
  const online = useOnline();
  const { hasUnread } = useReplies();
  const rewards = useRewards();

  return route.name === 'draw' ? (
    <EditorScreen key={route.parentId ?? 'root'} parentId={route.parentId} />
  ) : (
    <div className="app-shell">
      {!online && (
        <p className="offline-banner" role="status">
          Hors connexion : tu peux dessiner, mais pas publier ni continuer une case.
        </p>
      )}
      <main>
        <Page route={route} />
      </main>
      <Dock items={SIDES.map((n) => toItem(n, route.name, n.id === 'mine' && (hasUnread || rewards.hasNews)))} center={toItem(PLAY, route.name)} />
    </div>
  );
}

export function App() {
  const route = useRoute();
  // Survivor vit hors des fournisseurs du jeu classique: ils ouvrent un compte anonyme au chargement, et le Solo n'en veut pas.
  if (route.name === 'survivor') {
    return (
      <Suspense fallback={null}>
        <SurvivorPage invite={route.invite ?? null} />
      </Suspense>
    );
  }
  return (
    <GameProvider>
      <RepliesProvider>
        <RewardsProvider>
          <Screens />
        </RewardsProvider>
      </RepliesProvider>
    </GameProvider>
  );
}

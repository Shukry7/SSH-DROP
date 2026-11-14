import { createContext, useContext } from 'react';
import type { DesktopAPI } from '../../shared/contracts';

export const WorkspaceContext = createContext<{ api: DesktopAPI; active: boolean }>({
  api: window.sshdrop,
  active: true,
});
export const useWorkspace = () => useContext(WorkspaceContext);

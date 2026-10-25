import { getPluginNavItems, getPluginPanel, registerNavItems, registerPanel } from '@/lib/plugins'
import { LugosPanel } from './lugos-panel'
import { OgmiPanel } from './ogmi-panel'

if (!getPluginNavItems().some(item => item.id === 'lugos')) {
  registerNavItems([{
    id: 'lugos',
    label: 'Lugos',
    icon: 'L',
    groupId: 'observe',
  }])
}

if (!getPluginPanel('lugos')) registerPanel('lugos', LugosPanel)

if (!getPluginNavItems().some(item => item.id === 'ogmi')) {
  registerNavItems([{ id: 'ogmi', label: 'OGMI evidence', icon: 'O', groupId: 'observe' }])
}
if (!getPluginPanel('ogmi')) registerPanel('ogmi', OgmiPanel)

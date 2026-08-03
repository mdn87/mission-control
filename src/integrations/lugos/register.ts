import { getPluginNavItems, getPluginPanel, registerNavItems, registerPanel } from '@/lib/plugins'
import { LugosPanel } from './lugos-panel'

if (!getPluginNavItems().some(item => item.id === 'lugos')) {
  registerNavItems([{
    id: 'lugos',
    label: 'Lugos',
    icon: 'L',
    groupId: 'observe',
  }])
}

if (!getPluginPanel('lugos')) registerPanel('lugos', LugosPanel)

import * as p from '@clack/prompts';
import { getAllSkillsFromPlugins, discoverSkillNames, type SkillInfo } from '../../../core/skills.js';
import {
  removeDisabledSkill,
  addEnabledSkill,
  hasPlugin,
} from '../../../core/workspace-modify.js';
import {
  removeUserDisabledSkill,
  addUserEnabledSkill,
  isUserConfigPath,
  hasUserPlugin,
} from '../../../core/user-workspace.js';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import {
  listMarketplaces,
  listMarketplacePlugins,
} from '../../../core/marketplace.js';
import { searchSkills, qualifiedName, type SkillSearchItem } from '../../../core/skill-search.js';
import { getHomeDir } from '../../../constants.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';
import { installSelectedPlugin, runBrowsePluginSkills } from './plugins.js';
import { removeInstalledSkill } from '../../skill-removal.js';

const { multiselect, select, autocomplete, text } = p;

interface ScopedSkill extends SkillInfo {
  scope: 'user' | 'project';
  /** Unique key: "scope:pluginName:skillName" */
  key: string;
  /** Config key: "pluginName:skillName" */
  skillKey: string;
}

/**
 * Load skills from both user and project scopes, deduplicating overlaps.
 */
async function loadAllSkills(context: TuiContext): Promise<ScopedSkill[]> {
  const skills: ScopedSkill[] = [];

  // User-scope skills
  const userSkills = await getAllSkillsFromPlugins(getHomeDir());
  const userKeys = new Set<string>();

  for (const s of userSkills) {
    const skillKey = `${s.pluginName}:${s.name}`;
    userKeys.add(skillKey);
    skills.push({
      ...s,
      scope: 'user',
      key: `user:${skillKey}`,
      skillKey,
    });
  }

  // Project-scope skills (only if workspace exists and isn't the user config)
  if (context.workspacePath && !isUserConfigPath(context.workspacePath)) {
    const projectSkills = await getAllSkillsFromPlugins(context.workspacePath);
    for (const s of projectSkills) {
      const skillKey = `${s.pluginName}:${s.name}`;
      // Deduplicate: skip if same skill exists in user scope
      if (userKeys.has(skillKey)) continue;
      skills.push({
        ...s,
        scope: 'project',
        key: `project:${skillKey}`,
        skillKey,
      });
    }
  }

  return skills;
}

/**
 * Marketplace skill info for display
 */
interface MarketplaceSkillPreview {
  skillName: string;
  pluginName: string;
  marketplaceName: string;
  pluginRef: string;
  pluginDescription?: string | undefined;
}

/**
 * Load skills available from all configured marketplaces.
 * Scans each marketplace plugin's local directory for skills.
 */
async function loadMarketplaceSkills(cache?: TuiCache): Promise<MarketplaceSkillPreview[]> {
  const previews: MarketplaceSkillPreview[] = [];

  try {
    const cachedMarketplaces = cache?.getMarketplaces();
    const marketplaces = cachedMarketplaces ?? await listMarketplaces();
    if (!cachedMarketplaces) cache?.setMarketplaces(marketplaces);

    for (const marketplace of marketplaces) {
      const cachedPlugins = cache?.getMarketplacePlugins(marketplace.name);
      const result = cachedPlugins ?? await listMarketplacePlugins(marketplace.name);
      if (!cachedPlugins) cache?.setMarketplacePlugins(marketplace.name, result);

      for (const plugin of result.plugins) {
        const skillNames = await discoverSkillNames(plugin.path);
        for (const skillName of skillNames) {
          const preview: MarketplaceSkillPreview = {
            skillName,
            pluginName: plugin.name,
            marketplaceName: marketplace.name,
            pluginRef: `${plugin.name}@${marketplace.name}`,
          };
          if (plugin.description) preview.pluginDescription = plugin.description;
          previews.push(preview);
        }
      }
    }
  } catch {
    // Marketplace unavailable — degrade gracefully
  }

  return previews;
}

/**
 * Skills — lets user toggle which skills are enabled/disabled via multiselect.
 * When no skills are installed, shows marketplace skills for discovery.
 */
export async function runSkills(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    const skills = await loadAllSkills(context);

    if (skills.length === 0) {
      // No skills installed — show marketplace skills for discovery
      await runBrowseMarketplaceSkills(context, cache);
      return;
    }

    // Skills exist — show toggle + browse + search options
    while (true) {
      const action = await select({
        message: 'Skills',
        options: [
          { label: 'Toggle installed skills', value: 'toggle' as const },
          { label: 'Browse marketplace skills...', value: 'browse' as const },
          { label: 'Search online...', value: 'search' as const },
          { label: 'Back', value: 'back' as const },
        ],
      });

      if (p.isCancel(action) || action === 'back') {
        return;
      }

      if (action === 'browse') {
        await runBrowseMarketplaceSkills(context, cache);
        continue;
      }

      if (action === 'search') {
        await runSearchOnlineSkills(context, cache);
        continue;
      }

      // Toggle skills
      await runToggleSkills(skills, context, cache);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Toggle installed skills via multiselect.
 */
async function runToggleSkills(
  skills: ScopedSkill[],
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  // Build multiselect options with metadata in hint
  const options = skills.map((s) => ({
    label: s.name,
    value: s.key,
    hint: `${s.pluginName} · ${s.scope}`,
  }));

  // Pre-select enabled skills (not disabled)
  const initialValues = skills.filter((s) => !s.disabled).map((s) => s.key);

  const selected = await multiselect({
    message: 'Toggle skills (selected = enabled)',
    options,
    initialValues,
    required: false,
  });

  if (p.isCancel(selected)) {
    return;
  }

  const selectedSet = new Set(selected);

  // Compute diff
  const toDisable = skills.filter((s) => !s.disabled && !selectedSet.has(s.key));
  const toEnable = skills.filter((s) => s.disabled && selectedSet.has(s.key));

  if (toDisable.length === 0 && toEnable.length === 0) {
    p.note('No changes made.', 'Skills');
    return;
  }

  const s = p.spinner();
  s.start('Updating skills...');

  let changedProject = false;
  let changedUser = false;

  // Disable newly unchecked skills
  for (const skill of toDisable) {
    const effectivePath = skill.scope === 'user' ? getHomeDir() : context.workspacePath;
    if (effectivePath) {
      await removeInstalledSkill({
        targetSkill: skill,
        isUser: skill.scope === 'user',
        workspacePath: effectivePath,
      });
    }
    if (skill.scope === 'user') changedUser = true;
    else changedProject = true;
  }

  // Enable newly checked skills
  for (const skill of toEnable) {
    if (skill.pluginSkillsMode === 'allowlist') {
      if (skill.scope === 'user') {
        await addUserEnabledSkill(skill.skillKey);
      } else if (context.workspacePath) {
        await addEnabledSkill(skill.skillKey, context.workspacePath);
      }
    } else {
      if (skill.scope === 'user') {
        await removeUserDisabledSkill(skill.skillKey);
      } else if (context.workspacePath) {
        await removeDisabledSkill(skill.skillKey, context.workspacePath);
      }
    }
    if (skill.scope === 'user') changedUser = true;
    else changedProject = true;
  }

  // Auto-sync affected scopes
  s.message('Updating...');
  if (changedProject && context.workspacePath) {
    await syncWorkspace(context.workspacePath);
  }
  if (changedUser) {
    await syncUserWorkspace();
  }
  s.stop('Skills updated');
  cache?.invalidate();

  const changes: string[] = [];
  for (const skill of toEnable) {
    changes.push(`✓ Enabled: ${skill.name} (${skill.pluginName}) [${skill.scope}]`);
  }
  for (const skill of toDisable) {
    changes.push(`✗ Disabled: ${skill.name} (${skill.pluginName}) [${skill.scope}]`);
  }
  p.note(changes.join('\n'), 'Updated');
}

/**
 * Truncate a list to maxVisible items, appending "+N more" if needed.
 */
function truncateList(items: string[], maxVisible = 3): string {
  if (items.length <= maxVisible) {
    return items.join(', ');
  }
  return `${items.slice(0, maxVisible).join(', ')} +${items.length - maxVisible} more`;
}

/**
 * Browse skills available from configured marketplaces.
 * Shows a skill-centric view grouped by plugin. Selecting a skill installs its plugin.
 */
async function runBrowseMarketplaceSkills(
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  const s = p.spinner();
  s.start('Loading marketplace skills...');
  const marketplaceSkills = await loadMarketplaceSkills(cache);
  s.stop('Marketplace skills loaded');

  if (marketplaceSkills.length === 0) {
    p.note(
      'No skills found in configured marketplaces.\nUse "Manage marketplaces" to add one first.',
      'Skills',
    );
    return;
  }

  // Group by plugin for display
  const byPlugin = new Map<string, { ref: string; description?: string | undefined; skills: string[] }>();
  for (const skill of marketplaceSkills) {
    const existing = byPlugin.get(skill.pluginRef);
    if (existing) {
      existing.skills.push(skill.skillName);
    } else {
      const entry: { ref: string; description?: string | undefined; skills: string[] } = {
        ref: skill.pluginRef,
        skills: [skill.skillName],
      };
      if (skill.pluginDescription) entry.description = skill.pluginDescription;
      byPlugin.set(skill.pluginRef, entry);
    }
  }

  // Build select options — one per plugin, with compact skill preview in hint
  const options: Array<{ label: string; value: string; hint?: string }> = [];
  for (const [pluginRef, data] of byPlugin) {
    const desc = data.description ? ` - ${data.description}` : '';
    options.push({
      label: `${pluginRef}${desc}`,
      value: pluginRef,
      hint: `${data.skills.length} skills: ${truncateList(data.skills)}`,
    });
  }
  options.push({ label: 'Back', value: '__back__' });

  const selected = await autocomplete({
    message: 'Select a plugin',
    options,
    placeholder: 'Type to search...',
  });

  if (p.isCancel(selected) || selected === '__back__') {
    return;
  }

  // Check if plugin is already installed in either scope
  const workspacePath = context.workspacePath ?? process.cwd();
  const isInstalledProject = context.workspacePath ? await hasPlugin(selected, workspacePath) : false;
  const isInstalledUser = await hasUserPlugin(selected);

  if (isInstalledProject || isInstalledUser) {
    // Plugin already installed — go straight to skill toggle
    const scope = isInstalledUser ? 'user' : 'project';
    await runBrowsePluginSkills(selected, scope, context, cache);
    return;
  }

  // Not installed — install first, then show skill toggle
  const result = await installSelectedPlugin(selected, context, cache);
  if (result.status === 'installed') {
    await runBrowsePluginSkills(result.source, result.scope, context, cache);
  }
}

/**
 * Search GitHub for skills by keyword, display results, and install a selected plugin.
 */
async function runSearchOnlineSkills(context: TuiContext, cache?: TuiCache): Promise<void> {
  const query = await text({
    message: 'Search for skills on GitHub',
    placeholder: 'e.g. commit, deploy, aws',
  });

  if (p.isCancel(query) || !query || query.trim().length === 0) {
    return;
  }

  const s = p.spinner();
  s.start('Searching GitHub...');

  let items: SkillSearchItem[];
  try {
    const result = await searchSkills(query.trim());
    items = result.items;
  } catch (error) {
    s.stop('Search failed');
    p.note(error instanceof Error ? error.message : String(error), 'Search Error');
    return;
  }

  s.stop(`Found ${items.length} skill${items.length !== 1 ? 's' : ''}`);

  if (items.length === 0) {
    p.note(`No skills found for "${query.trim()}".`, 'Search');
    return;
  }

  // One option per skill, showing name and repo
  const options: Array<{ label: string; value: string; hint?: string }> = items.map((item) => ({
    label: qualifiedName(item),
    value: item.repo,
    hint: item.repo + (item.description ? ` · ${item.description}` : ''),
  }));
  options.push({ label: 'Back', value: '__back__' });

  const selected = await autocomplete({
    message: `Results for "${query.trim()}"`,
    options,
    placeholder: 'Type to filter...',
  });

  if (p.isCancel(selected) || selected === '__back__') {
    return;
  }

  // Check if plugin is already installed in either scope
  const workspacePath = context.workspacePath ?? process.cwd();
  const isInstalledProject = context.workspacePath ? await hasPlugin(selected, workspacePath) : false;
  const isInstalledUser = await hasUserPlugin(selected);

  if (isInstalledProject || isInstalledUser) {
    const scope = isInstalledUser ? 'user' : 'project';
    await runBrowsePluginSkills(selected, scope, context, cache);
    return;
  }

  const result = await installSelectedPlugin(selected, context, cache);
  if (result.status === 'installed') {
    await runBrowsePluginSkills(result.source, result.scope, context, cache);
  }
}

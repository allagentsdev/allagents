import { type SkillInfo, getAllSkillsFromPlugins, getNativePluginSources, NATIVE_SKILL_SELECTION_ERROR } from '../core/skills.js';
import {
  addUserDisabledSkill,
  removeUserEnabledSkill,
  removeUserPlugin,
} from '../core/user-workspace.js';
import {
  addDisabledSkill,
  removeEnabledSkill,
  removePlugin,
} from '../core/workspace-modify.js';

export interface RemoveInstalledSkillOptions {
  targetSkill: Pick<
    SkillInfo,
    'name' | 'pluginName' | 'pluginSource' | 'pluginSkillsMode'
  >;
  isUser: boolean;
  workspacePath: string;
  allSkills?: SkillInfo[];
}

export interface RemoveInstalledSkillResult {
  success: boolean;
  error?: string;
  action?: 'removed-plugin' | 'removed-skill' | 'disabled-skill';
}

export async function removeInstalledSkill(
  options: RemoveInstalledSkillOptions,
): Promise<RemoveInstalledSkillResult> {
  const { targetSkill, isUser, workspacePath } = options;
  if ((await getNativePluginSources(workspacePath, isUser ? 'user' : 'project')).has(targetSkill.pluginSource)) {
    return {
      success: false,
      error: NATIVE_SKILL_SELECTION_ERROR,
    };
  }
  const allSkills =
    options.allSkills ?? (await getAllSkillsFromPlugins(workspacePath));
  const pluginSkills = allSkills.filter(
    (skill) => skill.pluginSource === targetSkill.pluginSource,
  );
  const remainingEnabledSkills = pluginSkills.filter(
    (skill) => !skill.disabled && skill.name !== targetSkill.name,
  );

  if (remainingEnabledSkills.length === 0) {
    const result = isUser
      ? await removeUserPlugin(targetSkill.pluginSource)
      : await removePlugin(targetSkill.pluginSource, workspacePath);

    return result.success
      ? { success: true, action: 'removed-plugin' }
      : { success: false, error: result.error ?? 'Unknown error' };
  }

  const skillKey = `${targetSkill.pluginName}:${targetSkill.name}`;
  const result =
    targetSkill.pluginSkillsMode === 'allowlist'
      ? isUser
        ? await removeUserEnabledSkill(skillKey)
        : await removeEnabledSkill(skillKey, workspacePath)
      : isUser
        ? await addUserDisabledSkill(skillKey)
        : await addDisabledSkill(skillKey, workspacePath);

  if (!result.success) {
    return { success: false, error: result.error ?? 'Unknown error' };
  }

  return {
    success: true,
    action:
      targetSkill.pluginSkillsMode === 'allowlist'
        ? 'removed-skill'
        : 'disabled-skill',
  };
}

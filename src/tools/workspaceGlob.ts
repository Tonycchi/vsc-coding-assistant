// Match * and ? within a path component, and ** across entire components.
// Dynamic programming keeps matching predictable even with repeated wildcards.
export function compileWorkspaceGlob(pattern: string): (path: string) => boolean {
  const parts = pattern.split('/');
  const basenameOnly = parts.length === 1 && pattern !== '**';

  return (path) => {
    const names = path.split('/');
    if (basenameOnly) {
      return matchComponent(pattern, names[names.length - 1] ?? '');
    }

    let matched = Array<boolean>(names.length + 1).fill(false);
    matched[0] = true;
    for (const part of parts) {
      const next = Array<boolean>(names.length + 1).fill(false);
      if (part === '**') {
        next[0] = matched[0] ?? false;
      }
      for (const [index, name] of names.entries()) {
        next[index + 1] =
          part === '**'
            ? Boolean(matched[index + 1] || next[index])
            : Boolean(matched[index] && matchComponent(part, name));
      }
      matched = next;
    }
    return matched[names.length] ?? false;
  };
}

function matchComponent(pattern: string, name: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === name;
  }

  const characters = Array.from(name);
  let matched = Array<boolean>(characters.length + 1).fill(false);
  matched[0] = true;
  for (const symbol of pattern) {
    const next = Array<boolean>(characters.length + 1).fill(false);
    if (symbol === '*') {
      next[0] = matched[0] ?? false;
    }
    for (const [index, character] of characters.entries()) {
      next[index + 1] =
        symbol === '*'
          ? Boolean(matched[index + 1] || next[index])
          : Boolean(matched[index] && (symbol === '?' || symbol === character));
    }
    matched = next;
  }
  return matched[characters.length] ?? false;
}

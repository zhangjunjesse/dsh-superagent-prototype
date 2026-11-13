/** Fully qualified host paths; Windows roots must identify a drive or UNC share, as DSH workspaces require. */
export function absolutePathPattern(platform: NodeJS.Platform = process.platform): RegExp {
  // Hex slash also keeps .source valid for HTML pattern's Unicode-set ('v') syntax.
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\\x2f]|[\\\x2f]{2}[^\\\x2f]+[\\\x2f]+[^\\\x2f]+(?:[\\\x2f]|$))/ : /^\x2f/
}

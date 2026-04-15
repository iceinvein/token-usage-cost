export function normalizeProjectName(project: string): string {
  if (project.startsWith("/")) {
    const parts = project.split("/").filter(Boolean);
    const markers = ["workspace", "src", "projects", "repos", "code"];

    for (const marker of markers) {
      const index = parts.lastIndexOf(marker);
      if (index >= 0 && index < parts.length - 1) {
        const tail = parts.slice(index + 1);
        if (tail.length >= 2 && tail.at(-1) === tail.at(-2)) {
          return tail.at(-1)!;
        }
        return tail.join("/");
      }
    }

    return parts.slice(-2).join("/") || project;
  }

  if (!project.startsWith("-")) {
    return project;
  }

  const parts = project.split("-").filter(Boolean);
  if (parts.length === 0) {
    return project;
  }

  const markers = ["workspace", "src", "projects", "repos", "code"];
  for (const marker of markers) {
    const index = parts.lastIndexOf(marker);
    if (index >= 0 && index < parts.length - 1) {
      const tail = parts.slice(index + 1);
      if (tail.length === 2 && tail[0] === tail[1]) {
        return tail[0];
      }
      return tail.join("-");
    }
  }

  if (parts.length === 2 && parts[0] === parts[1]) {
    return parts[0];
  }

  return parts.join("-");
}

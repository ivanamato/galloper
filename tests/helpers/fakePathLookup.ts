import { DoctorDeps } from '../../src/lib/Doctor.js';

export function createFakePathLookup(presentBinaries: Iterable<string>) {
  const binaries = new Set(presentBinaries);
  return async (bin: string): Promise<boolean> => {
    return binaries.has(bin);
  };
}

export function createFakeDoctorDeps(
  presentBinaries: Iterable<string> = [],
  existingPaths: Iterable<string> = []
): DoctorDeps {
  const paths = new Set(existingPaths);
  return {
    lookupOnPath: createFakePathLookup(presentBinaries),
    readFile: async () => '',
    pathExists: async (p: string): Promise<boolean> => {
      return paths.has(p);
    },
  };
}

import { DoctorDeps } from '../../src/lib/Doctor.js';

export function createFakePathLookup(presentBinaries: Iterable<string>) {
  const binaries = new Set(presentBinaries);
  return async (bin: string): Promise<boolean> => {
    return binaries.has(bin);
  };
}

export function createFakeDoctorDeps(presentBinaries: Iterable<string> = []): DoctorDeps {
  return {
    lookupOnPath: createFakePathLookup(presentBinaries),
    readFile: async () => '',
  };
}

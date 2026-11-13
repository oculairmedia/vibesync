/**
 * BeadsStore — the engine's single gateway to a project's Beads database.
 *
 * Reads come from the Dolt SQL connection (fast, and the ready-step query is a
 * join bd's CLI cannot express). Every write goes through the bd CLI so bd's
 * validation and invariants apply. Satisfies the MoleculeStore, ReadyStepStore
 * and WritebackStore ports, so callers do not know which path a call takes.
 */
import type { MoleculeStore } from '../molecule/molecule.js';
import type { WritebackStore } from '../molecule/index.js';
import type { BeadRow, DependencyRow } from '../store/index.js';
import type { CommandRunner } from './cli.js';
import { BdMoleculeWriter } from './molecule-writer.js';

export interface BeadsReader {
  getBead(id: string): Promise<BeadRow | null>;
  getBeadDependencies(id: string): Promise<DependencyRow[]>;
  findReadyStepsForMolecule(rootId: string): Promise<BeadRow[]>;
  findRunningStepsForMolecule(rootId: string): Promise<BeadRow[]>;
  listMoleculeRoots(opts?: { statuses?: readonly string[]; limit?: number }): Promise<BeadRow[]>;
}

/** The writer's own signatures: a superset of the MoleculeStore ports (root metadata, step input payload). */
type WriterMethods = Pick<BdMoleculeWriter, Exclude<keyof BdMoleculeWriter, never>>;

export class BeadsStore implements MoleculeStore, WritebackStore {
  private readonly writer: BdMoleculeWriter;

  constructor(private readonly reader: BeadsReader, bd: CommandRunner) {
    this.writer = new BdMoleculeWriter(bd, reader);
  }

  getBead(id: string) { return this.reader.getBead(id); }
  getBeadDependencies(id: string) { return this.reader.getBeadDependencies(id); }
  findReadyStepsForMolecule(rootId: string) { return this.reader.findReadyStepsForMolecule(rootId); }
  findRunningStepsForMolecule(rootId: string) { return this.reader.findRunningStepsForMolecule(rootId); }
  listMoleculeRoots(opts?: { statuses?: readonly string[]; limit?: number }) { return this.reader.listMoleculeRoots(opts); }

  insertMoleculeRoot: WriterMethods['insertMoleculeRoot'] = (args) => this.writer.insertMoleculeRoot(args);
  insertMoleculeStep: WriterMethods['insertMoleculeStep'] = (args) => this.writer.insertMoleculeStep(args);
  markStepRunning: WriterMethods['markStepRunning'] = (id) => this.writer.markStepRunning(id);
  recordStepTask: WriterMethods['recordStepTask'] = (id, task) => this.writer.recordStepTask(id, task);
  recordStepAttempt: WriterMethods['recordStepAttempt'] = (id, attempt) => this.writer.recordStepAttempt(id, attempt);
  reopenStepForRetry: WriterMethods['reopenStepForRetry'] = (id, args) => this.writer.reopenStepForRetry(id, args);
  reopenStepForRound: WriterMethods['reopenStepForRound'] = (id, args) => this.writer.reopenStepForRound(id, args);
  markStepDone: WriterMethods['markStepDone'] = (id, output) => this.writer.markStepDone(id, output);
  markStepFailed: WriterMethods['markStepFailed'] = (id, trace, outcome) => this.writer.markStepFailed(id, trace, outcome);
  markMoleculeRootStatus: WriterMethods['markMoleculeRootStatus'] = (id, status, outcome) => this.writer.markMoleculeRootStatus(id, status, outcome);
  appendNoteToBead: WriterMethods['appendNoteToBead'] = (id, note) => this.writer.appendNoteToBead(id, note);
  addCommentToBead: WriterMethods['addCommentToBead'] = (id, comment) => this.writer.addCommentToBead(id, comment);
  recordMoleculeWriteback: WriterMethods['recordMoleculeWriteback'] = (id, status) => this.writer.recordMoleculeWriteback(id, status);
}

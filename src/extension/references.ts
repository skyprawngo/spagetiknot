/**
 * @module references
 * @description Builds the call-graph edges and external-call list from indexed functions.
 *
 * ── Language-aware resolution strategy ──────────────────────────────────────
 *
 *  Languages WITH explicit project imports (Python, JS/TS):
 *    1. byName match        → ExternalCall (imported library symbol); skip project edge
 *    2. projectByName match → edge to the explicitly resolved file only
 *    3. Same-file definition exists → same-file edge only (local call)
 *    4. Name globally unique across project → allow cross-file edge
 *    5. Ambiguous (multiple files, no import evidence) → skip (false-edge prevention)
 *
 *  Languages WITHOUT explicit project imports (Swift, Go, Java/C#, C++):
 *    A. Same-file definition → same-file edge only
 *    B. Receiver-hint inference → lowercase(receiver) matched against file basenames
 *       e.g. `viewModel.fetch()` → receiver "viewModel" → look for "*viewmodel*.swift"
 *    C. Same-directory preference → within-package / within-module calls
 *       (Go: same dir = same package; Java: same dir ≈ same package)
 *    D. Globally unique → allow
 *    (Priority-5 "ambiguous skip" does NOT apply — within-module calls need no import)
 *
 * ── External call detection ──────────────────────────────────────────────────
 *
 *  • byName / byModule patterns for Python and JS/TS
 *  • SWIFT_FRAMEWORK_TYPES chain scan for Swift
 *    (catches `URLSession.shared.dataTask()`, `DispatchQueue.main.async {}`, etc.)
 *  • byModule modPattern for all languages (`requests.get()`, `axios.post()`)
 *
 * ── False-positive guards ────────────────────────────────────────────────────
 *
 *  • isInsideString() — skip call matches inside string literals
 *  • byModule filter — skip when immediate receiver is an explicitly imported module alias
 *  • Self-reference skip — skip edges where source === target node
 *  • Declaration-line skip — skip the function's own declaration line
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { FunctionInfo } from './parser';

// ── Language classification ───────────────────────────────────────────────────

type FileLanguage = 'python' | 'jsTs' | 'swift' | 'go' | 'javaLike' | 'other';

function getFileLanguage(filePath: string): FileLanguage {
  switch (path.extname(filePath).toLowerCase()) {
    case '.py':                              return 'python';
    case '.ts': case '.tsx':
    case '.js': case '.jsx':                return 'jsTs';
    case '.swift':                           return 'swift';
    case '.go':                              return 'go';
    case '.java': case '.cs':               return 'javaLike';
    default:                                 return 'other';
  }
}

/** True for languages that use explicit import declarations to reference project symbols. */
function hasExplicitProjectImports(lang: FileLanguage): boolean {
  return lang === 'python' || lang === 'jsTs';
}

// ── Swift framework type registry ─────────────────────────────────────────────

/**
 * Capitalized type names (and common singleton accessor names) that belong to
 * Apple frameworks. When any of these appear in the call chain before a method
 * call, that call is treated as an external library call rather than a project edge.
 */
const SWIFT_FRAMEWORK_TYPES = new Set([
  // Foundation
  'URLSession', 'URLRequest', 'URLComponents', 'URL', 'URLResponse', 'URLError',
  'UserDefaults', 'NotificationCenter', 'FileManager', 'Bundle',
  'DispatchQueue', 'DispatchGroup', 'DispatchSemaphore', 'DispatchWorkItem',
  'OperationQueue', 'Operation', 'BlockOperation', 'Thread', 'RunLoop', 'Timer',
  'JSONDecoder', 'JSONEncoder', 'PropertyListDecoder', 'PropertyListEncoder',
  'DateFormatter', 'ISO8601DateFormatter', 'NumberFormatter', 'MeasurementFormatter',
  'Calendar', 'DateComponents', 'TimeZone', 'Locale', 'Date',
  'NSObject', 'NSArray', 'NSDictionary', 'NSString', 'NSData', 'NSNumber',
  'NSError', 'NSException', 'NSNotification', 'NSCache',
  'Data', 'UUID', 'Decimal', 'Measurement', 'AttributedString',
  // UIKit
  'UIView', 'UIViewController', 'UINavigationController', 'UITabBarController',
  'UITableView', 'UITableViewCell', 'UICollectionView', 'UICollectionViewCell',
  'UILabel', 'UIButton', 'UIImageView', 'UIImage', 'UIStackView',
  'UIScrollView', 'UITextField', 'UITextView', 'UISearchBar',
  'UIAlertController', 'UIAlertAction',
  'UINavigationBar', 'UITabBar', 'UIToolbar', 'UIBarButtonItem',
  'UIApplication', 'UIWindow', 'UIScreen', 'UIDevice',
  'UIColor', 'UIFont', 'UIBezierPath', 'UIGestureRecognizer',
  'UIPanGestureRecognizer', 'UITapGestureRecognizer', 'UISwipeGestureRecognizer',
  'UIStoryboard', 'UINib', 'UIResponder', 'UIControl', 'UIEdgeInsets',
  // AppKit
  'NSView', 'NSViewController', 'NSWindow', 'NSApplication',
  'NSButton', 'NSTextField', 'NSImageView', 'NSTableView',
  'NSColor', 'NSFont', 'NSImage', 'NSMenu', 'NSMenuItem',
  // SwiftUI types (rarely used as receivers but included for completeness)
  'Text', 'Image', 'Button', 'VStack', 'HStack', 'ZStack',
  'NavigationView', 'NavigationLink', 'NavigationStack',
  'List', 'ForEach', 'Form', 'Group', 'Section',
  'GeometryReader', 'ScrollView', 'LazyVStack', 'LazyHStack',
  'Color', 'Font', 'Path', 'Shape', 'Canvas',
  // Combine
  'PassthroughSubject', 'CurrentValueSubject', 'AnyCancellable', 'AnyPublisher',
  // Core Data
  'NSManagedObjectContext', 'NSPersistentContainer', 'NSFetchRequest',
  'NSManagedObject', 'NSEntityDescription', 'NSPredicate', 'NSSortDescriptor',
  // AVFoundation
  'AVPlayer', 'AVPlayerItem', 'AVAudioPlayer', 'AVAudioSession', 'AVCaptureSession',
  // MapKit / CoreLocation
  'CLLocationManager', 'CLLocation', 'MKMapView',
  // WebKit / SafariServices
  'WKWebView', 'WKWebViewConfiguration', 'SFSafariViewController',
  // Photos
  'PHPhotoLibrary', 'PHAsset', 'PHFetchResult', 'PHImageManager',
  // UserNotifications
  'UNUserNotificationCenter', 'UNNotificationRequest', 'UNNotificationContent',
  // Common singleton accessor property names (these appear as the immediate
  // receiver when using singleton patterns like URLSession.shared.dataTask())
  'shared', 'default', 'standard', 'main', 'current',
]);

/**
 * Check whether the call chain before `callStart` on `line` contains a known
 * Apple framework type. Returns the matched type name, or null if none found.
 *
 * e.g.  "URLSession.shared.dataTask(" → "URLSession"
 *       "DispatchQueue.main.async {"  → "DispatchQueue"
 *       "viewModel.fetch("            → null
 */
function swiftExternalChainType(line: string, callStart: number): string | null {
  const prefix = line.slice(0, callStart);
  // Capitalized identifiers followed by '.' anywhere in the chain
  const chainHits = prefix.match(/\b([A-Z]\w*)\./g) ?? [];
  for (const hit of chainHits) {
    const typeName = hit.slice(0, -1);
    if (SWIFT_FRAMEWORK_TYPES.has(typeName)) return typeName;
  }
  // Singleton accessor as immediate receiver (e.g. ".shared.")
  const immMatch = prefix.match(/\b(\w+)\.$/);
  if (immMatch && SWIFT_FRAMEWORK_TYPES.has(immMatch[1])) return immMatch[1];
  return null;
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface FlowEdge {
  source: string;
  target: string;
  callerFile: string;
  callerLine: number;
  args: string[];
  params: string[];
}

/**
 * A call from a project function to an externally-imported library function.
 * Surfaced in the node-context popover, not shown as a graph edge.
 */
export interface ExternalCall {
  callerNodeId: string;
  name: string;
  realName: string;
  module: string;
}

export interface FindReferencesResult {
  edges: FlowEdge[];
  externalCalls: ExternalCall[];
}

// ── Parsed import descriptors ─────────────────────────────────────────────────

interface ExternalImport {
  module: string;
  originalName: string;
}

interface ParsedImports {
  /** External lib: `from X import Y as Z`  →  Z → { module: X, originalName: Y } */
  byName: Map<string, ExternalImport>;
  /** External lib: `import X as Y`          →  Y → real module name X */
  byModule: Map<string, string>;
  /**
   * Project relative import: `from ./util import fn` or `from .util import fn`
   *   →  localName → resolved absolute file path of the source module
   * Populated only for Python and JS/TS.
   */
  projectByName: Map<string, string>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function findReferences(
  functions: FunctionInfo[],
): Promise<FindReferencesResult> {
  const edges: FlowEdge[]             = [];
  const externalCalls: ExternalCall[] = [];

  // name → all FunctionInfo with that name across the project
  const funcByName = new Map<string, FunctionInfo[]>();
  for (const fn of functions) {
    const list = funcByName.get(fn.name) ?? [];
    list.push(fn);
    funcByName.set(fn.name, list);
  }

  const fileSet = new Set<string>(functions.map(fn => fn.filePath));

  // Map: lowercase(fileBasename) → [absolute paths]
  // Used by receiver-hint inference for Swift/Go/Java.
  const typeFileMap = buildTypeFileMap(fileSet);

  for (const filePath of fileSet) {
    const uri = vscode.Uri.file(filePath);
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); } catch { continue; }

    const lang   = getFileLanguage(filePath);
    const text   = doc.getText();
    const lines  = text.split('\n');
    const imports = parseImports(text, filePath, fileSet);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // ── Project-function call scan ───────────────────────────────────────
      for (const [name, targets] of funcByName) {

        // ── Priority 1 (import-based only): external library by name ───────
        if (hasExplicitProjectImports(lang)) {
          const extByName = imports.byName.get(name);
          if (extByName) {
            const pat = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, 'g');
            let m: RegExpExecArray | null;
            while ((m = pat.exec(line)) !== null) {
              if (isInsideString(line, m.index)) continue;
              const callerFn = findEnclosingFunction(functions, filePath, lineIdx);
              if (!callerFn) continue;
              externalCalls.push({
                callerNodeId: nodeId(callerFn),
                name,
                realName: extByName.originalName,
                module:   extByName.module,
              });
            }
            continue; // do not also build project edges for this name in this file
          }
        }

        // ── Resolve relevant targets (language-aware) ────────────────────
        const callPattern = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, 'g');
        let callMatch: RegExpExecArray | null;

        while ((callMatch = callPattern.exec(line)) !== null) {
          const callStart = callMatch.index;

          if (isInsideString(line, callStart)) continue;

          // Extract the immediate dot-receiver (if any)
          const receiverHint = extractReceiverHint(line, callStart);

          // Skip if receiver is an explicitly imported module alias
          if (receiverHint && imports.byModule.has(receiverHint)) continue;

          // Swift: detect framework-type calls → external call, not project edge
          if (lang === 'swift') {
            const frameworkType = swiftExternalChainType(line, callStart);
            if (frameworkType) {
              const callerFn = findEnclosingFunction(functions, filePath, lineIdx);
              if (callerFn) {
                externalCalls.push({
                  callerNodeId: nodeId(callerFn),
                  name:     `${frameworkType}.${name}`,
                  realName: name,
                  module:   frameworkType,
                });
              }
              continue;
            }
          }

          const resolvedTargets = resolveCallTargets(
            name, filePath, lang, imports, targets, receiverHint, typeFileMap,
          );
          if (resolvedTargets.length === 0) continue;

          const callerFn = findEnclosingFunction(functions, filePath, lineIdx);

          for (const target of resolvedTargets) {
            if (target.filePath === filePath && target.line === lineIdx) continue;
            if (callerFn && isSelfRef(callerFn, target)) continue;

            edges.push({
              source:     callerFn ? nodeId(callerFn) : `${filePath}:${lineIdx}:<top-level>`,
              target:     nodeId(target),
              callerFile: filePath,
              callerLine: lineIdx,
              args:       extractCallArgs(line, callMatch.index),
              params:     target.params,
            });
          }
        }
      }

      // ── External module-level calls: `requests.get(`, `axios.post(` ─────
      if (imports.byModule.size > 0) {
        const modPattern = /\b(\w+)\.(\w+)\s*\(/g;
        let modMatch: RegExpExecArray | null;
        while ((modMatch = modPattern.exec(line)) !== null) {
          const alias    = modMatch[1];
          const funcName = modMatch[2];
          if (!imports.byModule.has(alias)) continue;
          if (isInsideString(line, modMatch.index)) continue;

          const callerFn = findEnclosingFunction(functions, filePath, lineIdx);
          if (!callerFn) continue;

          externalCalls.push({
            callerNodeId: nodeId(callerFn),
            name:     `${alias}.${funcName}`,
            realName: funcName,
            module:   imports.byModule.get(alias)!,
          });
        }
      }
    }
  }

  return {
    edges:         deduplicateEdges(edges),
    externalCalls: deduplicateExternalCalls(externalCalls),
  };
}

// ── Language-aware target resolution ─────────────────────────────────────────

/**
 * Given a function name and all project functions with that name, return the
 * subset that should receive an edge from `callerFilePath`.
 *
 * For import-based languages (Python, JS/TS): uses the 5-priority system.
 * For non-import languages (Swift, Go, Java/C#): uses proximity heuristics.
 */
function resolveCallTargets(
  name: string,
  callerFilePath: string,
  lang: FileLanguage,
  imports: ParsedImports,
  targets: FunctionInfo[],
  receiverHint: string | null,
  typeFileMap: Map<string, string[]>,
): FunctionInfo[] {

  if (hasExplicitProjectImports(lang)) {
    // ── Priority 2: explicit relative import ──────────────────────────────
    const projectImportPath = imports.projectByName.get(name);
    if (projectImportPath) {
      return targets.filter(t => t.filePath === projectImportPath);
    }
    // ── Priority 3: same-file definition takes precedence ─────────────────
    const sameFile = targets.filter(t => t.filePath === callerFilePath);
    if (sameFile.length > 0) return sameFile;
    // ── Priority 4: globally unique name ──────────────────────────────────
    if (targets.length === 1) return targets;
    // ── Priority 5: ambiguous — skip to prevent false edges ───────────────
    return [];
  }

  // ── Non-import languages: Swift, Go, Java/C#, C++ ─────────────────────────

  // Step A: same-file definition
  const sameFile = targets.filter(t => t.filePath === callerFilePath);
  if (sameFile.length > 0) return sameFile;

  // Step B: receiver-hint → infer type → match against file basenames
  //   `viewModel.fetchData()` → receiver "viewModel" → look for "*viewmodel*" files
  if (receiverHint) {
    const inferred = inferTargetsFromReceiver(receiverHint, targets, typeFileMap);
    if (inferred.length > 0) return inferred;
  }

  // Step C: same-directory preference (within-package / within-module)
  //   Go: same dir = same package (authoritative)
  //   Swift: same dir ≈ same logical group (heuristic)
  //   Java: same dir ≈ same package (heuristic)
  const callerDir = path.dirname(callerFilePath);
  const sameDir   = targets.filter(t => path.dirname(t.filePath) === callerDir);
  if (sameDir.length > 0) return sameDir;

  // Step D: globally unique name across the whole project
  if (targets.length === 1) return targets;

  // Step E: ambiguous cross-directory with no receiver hint — skip
  //   (Better to miss edges than to draw dozens of false ones)
  return [];
}

/**
 * Given a receiver variable name (e.g. "viewModel"), return targets whose
 * source file's basename contains the receiver name (case-insensitive).
 *
 * "viewModel"       → matches "ViewModel.swift", "ContentViewModel.swift"
 * "apiService"      → matches "APIService.swift", "ApiService.swift"
 * "networkManager"  → matches "NetworkManager.swift"
 */
function inferTargetsFromReceiver(
  receiver: string,
  targets: FunctionInfo[],
  typeFileMap: Map<string, string[]>,
): FunctionInfo[] {
  const rcvLower = receiver.toLowerCase();
  const candidateFiles = new Set<string>();

  for (const [baseName, files] of typeFileMap) {
    // Match if the file base name contains the receiver, or receiver contains the base name
    // (handles both "ViewModel.swift" and "ContentViewModel.swift" for receiver "viewModel")
    if (baseName.includes(rcvLower) || rcvLower.includes(baseName)) {
      for (const f of files) candidateFiles.add(f);
    }
  }

  return targets.filter(t => candidateFiles.has(t.filePath));
}

/**
 * Build a map: lowercase(fileBasenameWithoutExt) → [absolute file paths].
 * Used for receiver-to-type file inference.
 */
function buildTypeFileMap(fileSet: Set<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const fp of fileSet) {
    const base = path.basename(fp, path.extname(fp)).toLowerCase();
    const list = map.get(base) ?? [];
    list.push(fp);
    map.set(base, list);
  }
  return map;
}

// ── Import parsing ────────────────────────────────────────────────────────────

function parseImports(
  text: string,
  filePath: string,
  fileSet: Set<string>,
): ParsedImports {
  const byName        = new Map<string, ExternalImport>();
  const byModule      = new Map<string, string>();
  const projectByName = new Map<string, string>();
  const ext           = path.extname(filePath).toLowerCase();

  if (ext === '.py') {
    parsePythonImports(text, filePath, fileSet, byName, byModule, projectByName);
  } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    parseJsTsImports(text, filePath, fileSet, byName, byModule, projectByName);
  } else if (ext === '.swift') {
    parseSwiftImports(text, byModule);
  }

  return { byName, byModule, projectByName };
}

/** Export for unit-testability. */
export function parseExternalImports(text: string, filePath: string): Set<string> {
  const { byName, byModule } = parseImports(text, filePath, new Set());
  return new Set([...byName.keys(), ...byModule.keys()]);
}

function parsePythonImports(
  text: string,
  callerFilePath: string,
  fileSet: Set<string>,
  byName: Map<string, ExternalImport>,
  byModule: Map<string, string>,
  projectByName: Map<string, string>,
): void {
  const fromImport = /^[ \t]*from\s+(\S+)\s+import\s+([^\n\\]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = fromImport.exec(text)) !== null) {
    const moduleName = m[1];

    if (moduleName.startsWith('.')) {
      const resolved = resolvePythonModule(moduleName, callerFilePath, fileSet);
      if (!resolved) continue;

      for (const part of m[2].split(',')) {
        const asMatch      = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        const importedName = asMatch ? asMatch[1] : part.trim().match(/^(\w+)/)?.[1];
        const localName    = asMatch ? asMatch[2] : importedName;
        if (!localName || !importedName) continue;

        if (resolved.type === 'file') {
          projectByName.set(localName, resolved.path);
        } else {
          const candidate = path.join(resolved.path, importedName + '.py');
          if (fileSet.has(candidate)) projectByName.set(localName, candidate);
        }
      }
    } else {
      for (const part of m[2].split(',')) {
        const asMatch = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          byName.set(asMatch[2], { module: moduleName, originalName: asMatch[1] });
        } else {
          const name = part.trim().match(/^(\w+)/)?.[1];
          if (name) byName.set(name, { module: moduleName, originalName: name });
        }
      }
    }
  }

  const importLine = /^[ \t]*import\s+(\S+?)(?:\s+as\s+(\w+))?[ \t]*$/gm;
  while ((m = importLine.exec(text)) !== null) {
    const realModule = m[1];
    if (realModule.startsWith('.')) continue;
    const alias = m[2] || realModule.split('.')[0];
    byModule.set(alias, realModule);
  }
}

function parseJsTsImports(
  text: string,
  callerFilePath: string,
  fileSet: Set<string>,
  byName: Map<string, ExternalImport>,
  byModule: Map<string, string>,
  projectByName: Map<string, string>,
): void {
  const namedImport =
    /^[ \t]*import\s+(?!type\s)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = namedImport.exec(text)) !== null) {
    const source = m[2];

    if (source.startsWith('.')) {
      const resolvedPath = resolveJsTsModule(source, callerFilePath, fileSet);
      if (!resolvedPath) continue;

      for (const part of m[1].split(',')) {
        const asMatch   = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        const localName = asMatch ? asMatch[2] : part.trim().match(/^(\w+)/)?.[1];
        if (localName) projectByName.set(localName, resolvedPath);
      }
    } else {
      for (const part of m[1].split(',')) {
        const asMatch = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) {
          byName.set(asMatch[2], { module: source, originalName: asMatch[1] });
        } else {
          const name = part.trim().match(/^(\w+)/)?.[1];
          if (name) byName.set(name, { module: source, originalName: name });
        }
      }
    }
  }

  // Default import: import Foo from 'source'
  const defaultImport =
    /^[ \t]*import\s+(?!type\s)(\w+)\s+from\s+['"]([^'"]+)['"]/gm;
  while ((m = defaultImport.exec(text)) !== null) {
    if (!m[2].startsWith('.')) byModule.set(m[1], m[2]);
  }

  // Namespace: import * as _ from 'lodash'
  const starImport =
    /^[ \t]*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm;
  while ((m = starImport.exec(text)) !== null) {
    if (!m[2].startsWith('.')) byModule.set(m[1], m[2]);
  }
}

function parseSwiftImports(
  text: string,
  byModule: Map<string, string>,
): void {
  // `import Foundation`, `import UIKit`, `import SwiftUI`, etc.
  const importLine = /^[ \t]*import\s+(\w+)[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = importLine.exec(text)) !== null) {
    byModule.set(m[1], m[1]);
  }
}

// ── Relative path resolution ──────────────────────────────────────────────────

type ResolvedModule =
  | { type: 'file'; path: string }
  | { type: 'dir';  path: string };

function resolvePythonModule(
  moduleName: string,
  callerFilePath: string,
  fileSet: Set<string>,
): ResolvedModule | undefined {
  const mm = moduleName.match(/^(\.+)(.*)/);
  if (!mm) return undefined;

  const dots = mm[1].length;
  const rest  = mm[2];

  let base = path.dirname(callerFilePath);
  for (let i = 1; i < dots; i++) base = path.dirname(base);

  if (rest === '') return { type: 'dir', path: base };

  const segments = rest.replace(/\./g, path.sep);
  const fileCand = path.join(base, segments + '.py');
  if (fileSet.has(fileCand)) return { type: 'file', path: fileCand };

  const pkgCand = path.join(base, segments, '__init__.py');
  if (fileSet.has(pkgCand)) return { type: 'file', path: pkgCand };

  return undefined;
}

function resolveJsTsModule(
  source: string,
  callerFilePath: string,
  fileSet: Set<string>,
): string | undefined {
  const base = path.resolve(path.dirname(callerFilePath), source);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const c = base + ext;
    if (fileSet.has(c)) return c;
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const c = path.join(base, 'index' + ext);
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return the immediate dot-receiver name before a call site, or null.
 * e.g. for `viewModel.fetch(` at callStart → returns "viewModel"
 * for `URLSession.shared.dataTask(` → returns "shared" (immediate only)
 */
function extractReceiverHint(line: string, callStart: number): string | null {
  if (callStart === 0 || line[callStart - 1] !== '.') return null;
  const prefixMatch = line.slice(0, callStart).match(/(\w+)\.$/);
  return prefixMatch ? prefixMatch[1] : null;
}

/**
 * Heuristic string-literal detector.
 * Counts unescaped quote characters before `pos` to determine if the position
 * falls inside a string. Handles single-line `"..."` and `'...'`.
 * Does not handle template literals or multi-line strings.
 */
function isInsideString(line: string, pos: number): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < pos; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === "'" && !inDouble) inSingle = !inSingle;
  }
  return inDouble || inSingle;
}

function findEnclosingFunction(
  functions: FunctionInfo[],
  filePath: string,
  line: number,
): FunctionInfo | undefined {
  // Sort by line ascending so we can use the "last fn whose start <= line AND
  // next fn's start > line" boundary heuristic.
  const fileFns = functions
    .filter(fn => fn.filePath === filePath)
    .sort((a, b) => a.line - b.line);

  let best: FunctionInfo | undefined;
  for (let i = 0; i < fileFns.length; i++) {
    if (fileFns[i].line > line) break;
    const nextStart = fileFns[i + 1]?.line ?? Infinity;
    // If the NEXT function has already started, the current line is after this
    // function's body — but we still take it as our best candidate (no end-line
    // info available) and keep scanning for a closer one.
    best = fileFns[i];
    if (nextStart > line) break; // this is the tightest enclosing function
  }
  return best;
}

function isSelfRef(caller: FunctionInfo, target: FunctionInfo): boolean {
  return (
    caller.name     === target.name &&
    caller.filePath === target.filePath &&
    caller.line     === target.line
  );
}

export function nodeId(fn: FunctionInfo): string {
  return `${fn.filePath}:${fn.line}:${fn.name}`;
}

function extractCallArgs(line: string, matchStart: number): string[] {
  const parenIdx = line.indexOf('(', matchStart);
  if (parenIdx === -1) return [];
  let depth = 0, closeIdx = -1;
  for (let i = parenIdx; i < line.length; i++) {
    if (line[i] === '(') depth++;
    if (line[i] === ')') depth--;
    if (depth === 0) { closeIdx = i; break; }
  }
  if (closeIdx === -1) return [];
  const inner = line.slice(parenIdx + 1, closeIdx).trim();
  if (!inner) return [];

  const args: string[] = [];
  let current = '', d = 0;
  for (const ch of inner) {
    if ('([{<'.includes(ch)) d++;
    if (')]}>'.includes(ch)) d--;
    if (ch === ',' && d === 0) { args.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deduplicateEdges(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.source}->${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateExternalCalls(calls: ExternalCall[]): ExternalCall[] {
  const seen = new Set<string>();
  return calls.filter(c => {
    const key = `${c.callerNodeId}→${c.module}.${c.realName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

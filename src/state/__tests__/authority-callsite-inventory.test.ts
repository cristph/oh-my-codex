import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript-compiler-api';
import { tmpdir } from 'node:os';

import {
  AUTHORITY_CALLSITE_INVENTORY,
  AUTHORITY_DYNAMIC_CALL_WAIVERS,
  AUTHORITY_DYNAMIC_ENV_ACCESS_WAIVERS,
  AUTHORITY_TRANSITIVE_BOUNDARY_KEYS,
  AUTHORITY_TRANSITIVE_HELPER_KEYS,
  AUTHORITY_REGISTRY_CANDIDATE_HELPER_KEYS,
  AUTHORITY_VALIDATION_BOUNDARY_KEYS,
  type AuthorityCallsiteClassification,
  type AuthorityCallsiteInventoryEntry,
  type AuthorityDynamicCallWaiver,
  type AuthorityDynamicEnvAccessWaiver,
} from '../authority-callsite-inventory.js';

type Definition = {
  key: string;
  path: string;
  symbol: string;
  node: ts.Node;
  symbolObject?: ts.Symbol;
};

type DirectEnvAccess = {
  envName: string;
  access: 'read' | 'write';
  key: string;
  path: string;
  symbol: string;
  location: string;
};
type DirectStatePathConstruction = {
  key: string;
  path: string;
  symbol: string;
  location: string;
};

type DynamicAuthorityCall = {
  key: string;
  path: string;
  symbol: string;
  sourceRange: string;
  targetText: string;
  node: ts.CallExpression;
};

type DynamicEnvironmentAccess = {
  key: string;
  path: string;
  symbol: string;
  sourceRange: string;
  targetText: string;
  node: ts.ElementAccessExpression;
};

type AuthorityInventoryValidationInput = {
  root: string;
  program: ts.Program;
  inventory: readonly AuthorityCallsiteInventoryEntry[];
  dynamicWaivers: readonly AuthorityDynamicCallWaiver[];
  dynamicEnvironmentWaivers: readonly AuthorityDynamicEnvAccessWaiver[];
  helperKeys: readonly string[];
  boundaryKeys: readonly string[];
  requiredTransportWriterKeys?: readonly string[];
  precommitKeys?: readonly string[];
  registryCandidateHelperKeys?: readonly string[];
  validationBoundaryKeys?: readonly string[];
  requireAmbientRootReader?: boolean;
  requireTransportAccess?: boolean;
  requireStatePathConstruction?: boolean;
};

type UnresolvedAuthorityCall = {
  key: string;
  path: string;
  symbol: string;
  location: string;
  targetText: string;
};

const ROOT_ENV_NAMES = new Set([
  'OMX_RUNS_DIR',
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
]);
const AUTHORITY_TRANSPORT_ENV_NAMES = new Set([
  'OMX_STARTUP_CWD',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
]);
const TRACKED_ENV_NAMES = new Set([
  ...ROOT_ENV_NAMES,
  ...AUTHORITY_TRANSPORT_ENV_NAMES,
]);
const ROOT_ENV_CONSTANT_NAMES = new Map([
  ['OMX_ROOT_ENV', 'OMX_ROOT'],
  ['OMX_STATE_ROOT_ENV', 'OMX_STATE_ROOT'],
  ['OMX_TEAM_STATE_ROOT_ENV', 'OMX_TEAM_STATE_ROOT'],
  ['TEAM_STATE_ROOT_ENV', 'OMX_TEAM_STATE_ROOT'],
  ['OMX_STARTUP_CWD_ENV', 'OMX_STARTUP_CWD'],
  ['OMX_STATE_AUTHORITY_PATH_ENV', 'OMX_STATE_AUTHORITY_PATH'],
  ['OMX_STATE_AUTHORITY_ID_ENV', 'OMX_STATE_AUTHORITY_ID'],
  [
    'OMX_STATE_AUTHORITY_GENERATION_ID_ENV',
    'OMX_STATE_AUTHORITY_GENERATION_ID',
  ],
  [
    'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV',
    'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  ],
  ['OMX_STATE_AUTHORITY_CAPABILITY_ENV', 'OMX_STATE_AUTHORITY_CAPABILITY'],
]);
const INVENTORY_PATH = 'src/state/authority-callsite-inventory.ts';
const TEST_PATH = 'src/state/__tests__/authority-callsite-inventory.test.ts';
const POSTCOMMIT_TRANSPORT_WRITER_KEYS = [
  'src/state/transport-env.ts::buildStateAuthorityTransportEnv',
  'src/state/authority.ts::publishStateAuthorityLaunchTransport',
  'src/auth/hotswap.ts::runAuthHotswap',
  'src/auth/hotswap.ts::resolveCurrentHotswapAuthority',
] as const;
const MAX_CALLER_DEPTH = 8;
const MAX_LOCAL_ALIAS_DEPTH = 4;
const POSTCOMMIT_TRANSPORT_PHASE = 'phase-2-postcommit-transport';
const AUTHORITY_RELEVANT_CALL_PATTERN =
  /(?:authority|registry|runsRoot|omx(?:Root|State)|state(?:Dir|Path))/i;

function repoRoot(): string {
  let current = resolve(process.cwd());
  while (!existsSync(resolve(current, 'tsconfig.json'))) {
    const parent = dirname(current);
    if (parent === current)
      throw new Error('could not find repository tsconfig.json');
    current = parent;
  }
  return current;
}

function normalizeRepoPath(root: string, fileName: string): string {
  return relative(root, fileName).split(sep).join('/');
}

function createProductionProgram(root: string): ts.Program {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    undefined,
    configPath,
  );
  const diagnostics = [...parsed.errors];
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        )
        .join('\n'),
    );
  }
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function createMutationFixtureProgram(files: Record<string, string>): {
  root: string;
  program: ts.Program;
} {
  const root = mkdtempSync(join(tmpdir(), 'omx-authority-inventory-mutation-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
    },
    include: ['src/**/*.ts'],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, program: createProductionProgram(root) };
}

function isProductionSource(root: string, sourceFile: ts.SourceFile): boolean {
  const path = normalizeRepoPath(root, sourceFile.fileName);
  return (
    path.startsWith('src/') &&
    !path.includes('/__tests__/') &&
    path !== INVENTORY_PATH &&
    path !== TEST_PATH &&
    !sourceFile.isDeclarationFile
  );
}

function resolveAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    return checker.getAliasedSymbol(symbol);
  return symbol;
}

function staticPropertyName(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) return undefined;
  return checker
    ? staticStringValue(checker, name.expression)
    : stringLiteralValue(name.expression);
}

function staticMemberName(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  return checker
    ? staticStringValue(checker, expression.argumentExpression)
    : stringLiteralValue(expression.argumentExpression);
}

function functionDefinitionIdentity(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): { name: string; symbolNode: ts.Node } | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const name = node.name && staticPropertyName(node.name, checker);
    return name && node.name ? { name, symbolNode: node.name } : undefined;
  }
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return undefined;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { name: parent.name.text, symbolNode: parent.name };
  }
  if (ts.isPropertyAssignment(parent)) {
    const name = staticPropertyName(parent.name, checker);
    return name ? { name, symbolNode: parent.name } : undefined;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    const name = staticMemberName(parent.left, checker);
    return name ? { name, symbolNode: parent.left } : undefined;
  }
  return undefined;
}

function isNamedFunctionLike(
  node: ts.Node,
  checker: ts.TypeChecker,
): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)) &&
    functionDefinitionIdentity(node, checker) !== undefined
  );
}

function collectDefinitions(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
): {
  definitions: Definition[];
  definitionForNode: Map<ts.Node, Definition>;
  definitionForSymbol: Map<ts.Symbol, Definition>;
  definitionsByKey: Map<string, Definition[]>;
} {
  const definitions: Definition[] = [];
  const definitionForNode = new Map<ts.Node, Definition>();
  const definitionForSymbol = new Map<ts.Symbol, Definition>();
  const definitionsByKey = new Map<string, Definition[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const moduleDefinition: Definition = {
      key: `${path}::<module>`,
      path,
      symbol: '<module>',
      node: sourceFile,
    };
    definitions.push(moduleDefinition);
    definitionForNode.set(sourceFile, moduleDefinition);
    definitionsByKey.set(moduleDefinition.key, [moduleDefinition]);
    const visit = (node: ts.Node): void => {
      if (isNamedFunctionLike(node, checker)) {
        const identity = functionDefinitionIdentity(node, checker)!;
        const symbolObject = resolveAlias(
          checker,
          checker.getSymbolAtLocation(identity.symbolNode),
        );
        const definition: Definition = {
          key: `${path}::${identity.name}`,
          path,
          symbol: identity.name,
          node,
          symbolObject,
        };
        definitions.push(definition);
        definitionForNode.set(node, definition);
        const bucket = definitionsByKey.get(definition.key) ?? [];
        bucket.push(definition);
        definitionsByKey.set(definition.key, bucket);
        if (symbolObject) definitionForSymbol.set(symbolObject, definition);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    definitions,
    definitionForNode,
    definitionForSymbol,
    definitionsByKey,
  };
}

function enclosingDefinition(
  node: ts.Node,
  definitions: Map<ts.Node, Definition>,
): Definition | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const definition = definitions.get(current);
    if (definition) return definition;
    current = current.parent;
  }
  return undefined;
}

function inventoryKey(
  entry: Pick<AuthorityCallsiteInventoryEntry, 'path' | 'symbol'>,
): string {
  return `${entry.path}::${entry.symbol}`;
}

function buildInventoryMap(
  inventory: readonly AuthorityCallsiteInventoryEntry[],
  violations: string[],
): Map<string, AuthorityCallsiteInventoryEntry> {
  const result = new Map<string, AuthorityCallsiteInventoryEntry>();
  for (const entry of inventory) {
    const key = inventoryKey(entry);
    if (result.has(key)) violations.push(`[duplicate-inventory-row] ${key}`);
    if (!/^src\/.+\.ts$/.test(entry.path))
      violations.push(`[invalid-inventory-path] ${entry.path}`);
    if (entry.classification === undefined)
      violations.push(`[missing-classification] ${key}`);
    if (!entry.owner.trim()) violations.push(`[missing-owner] ${key}`);
    if (!entry.rationale.trim()) violations.push(`[missing-rationale] ${key}`);
    if (!entry.migration_phase.trim())
      violations.push(`[missing-migration-phase] ${key}`);
    result.set(key, entry);
  }
  return result;
}

function sourceContainsExportSpecifier(
  sourceFile: ts.SourceFile,
  symbol: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportSpecifier(node) &&
      (node.name.text === symbol || node.propertyName?.text === symbol)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findSourceFile(
  program: ts.Program,
  root: string,
  path: string,
): ts.SourceFile | undefined {
  return program
    .getSourceFiles()
    .find(
      (sourceFile) => normalizeRepoPath(root, sourceFile.fileName) === path,
    );
}

function isConstVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function collectStaticPropertyAssignments(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
): Map<ts.Symbol, ts.Expression | undefined> {
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        staticMemberName(node.left, checker) !== undefined
      ) {
        const symbol = resolveAlias(
          checker,
          checker.getSymbolAtLocation(node.left),
        );
        if (symbol) {
          const values = assignments.get(symbol) ?? [];
          values.push(node.right);
          assignments.set(symbol, values);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return new Map(
    [...assignments].map(([symbol, values]) => [
      symbol,
      values.length === 1 ? values[0] : undefined,
    ]),
  );
}

function hasObjectPropertyInitializer(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some(
    (declaration) =>
      ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration) ||
      ts.isMethodDeclaration(declaration),
  ) === true;
}

function callableInitializer(
  symbol: ts.Symbol,
  propertyAssignments: ReadonlyMap<ts.Symbol, ts.Expression | undefined>,
): ts.Expression | undefined {
  if (propertyAssignments.has(symbol)) {
    if (hasObjectPropertyInitializer(symbol)) return undefined;
    return propertyAssignments.get(symbol);
  }
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      return declaration.initializer;
    }
    if (ts.isPropertyAssignment(declaration)) return declaration.initializer;
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return declaration.objectAssignmentInitializer ?? declaration.name;
    }
  }
  return undefined;
}

function isFunctionValue(expression: ts.Expression): boolean {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function resolvesToMethod(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some(
    (declaration) =>
      ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isSetAccessorDeclaration(declaration),
  ) === true;
}

function resolveCallableSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  propertyAssignments: ReadonlyMap<ts.Symbol, ts.Expression | undefined>,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): ts.Symbol | undefined {
  const isStaticReference =
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    (ts.isElementAccessExpression(expression) &&
      staticStringValue(checker, expression.argumentExpression) !== undefined);
  if (!isStaticReference) return undefined;

  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || depth >= MAX_LOCAL_ALIAS_DEPTH || seen.has(symbol)) {
    return symbol;
  }
  if (resolvesToMethod(symbol)) return symbol;
  seen.add(symbol);
  const shorthandDeclaration = symbol.declarations?.find(
    (declaration): declaration is ts.ShorthandPropertyAssignment =>
      ts.isShorthandPropertyAssignment(declaration),
  );
  const shorthandValueSymbol = resolveAlias(
    checker,
    checker.getShorthandAssignmentValueSymbol(shorthandDeclaration),
  );
  if (shorthandValueSymbol && shorthandValueSymbol !== symbol) {
    const shorthandInitializer = callableInitializer(
      shorthandValueSymbol,
      propertyAssignments,
    );
    if (!shorthandInitializer || isFunctionValue(shorthandInitializer)) {
      return shorthandValueSymbol;
    }
    return resolveCallableSymbol(
      checker,
      shorthandInitializer,
      propertyAssignments,
      depth + 1,
      seen,
    );
  }
  const initializer = callableInitializer(symbol, propertyAssignments);
  if (!initializer || isFunctionValue(initializer)) return symbol;
  return resolveCallableSymbol(
    checker,
    initializer,
    propertyAssignments,
    depth + 1,
    seen,
  );
}

function getCallTargetSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  propertyAssignments: ReadonlyMap<ts.Symbol, ts.Expression | undefined>,
): ts.Symbol | undefined {
  return resolveCallableSymbol(checker, expression, propertyAssignments);
}

function definitionForResolvedSymbol(
  symbol: ts.Symbol | undefined,
  definitionForSymbol: ReadonlyMap<ts.Symbol, Definition>,
): Definition | undefined {
  if (!symbol) return undefined;
  const direct = definitionForSymbol.get(symbol);
  if (direct) return direct;
  const declarations = new Set(symbol.declarations ?? []);
  if (declarations.size === 0) return undefined;
  for (const [candidate, definition] of definitionForSymbol) {
    if (candidate.declarations?.some((declaration) => declarations.has(declaration))) {
      return definition;
    }
  }
  return undefined;
}

function isCallableReferenceExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  return (
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    (ts.isElementAccessExpression(expression) &&
      staticStringValue(checker, expression.argumentExpression) !== undefined)
  );
}

function buildCallerGraph(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  definitionForNode: Map<ts.Node, Definition>,
  definitionForSymbol: Map<ts.Symbol, Definition>,
): Map<string, Set<string>> {
  const callersByTarget = new Map<string, Set<string>>();
  const propertyAssignments = collectStaticPropertyAssignments(
    root,
    program,
    checker,
  );
  const addCaller = (target: Definition, caller: Definition): void => {
    if (target.key === caller.key) return;
    const callers = callersByTarget.get(target.key) ?? new Set<string>();
    callers.add(caller.key);
    callersByTarget.set(target.key, callers);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const caller = enclosingDefinition(node, definitionForNode);
        const addReference = (expression: ts.Expression): void => {
          const targetSymbol = getCallTargetSymbol(
            checker,
            expression,
            propertyAssignments,
          );
          const target = definitionForResolvedSymbol(
            targetSymbol,
            definitionForSymbol,
          );
          if (target && caller) addCaller(target, caller);
        };
        addReference(node.expression);
        for (const argument of node.arguments) {
          if (isCallableReferenceExpression(checker, argument)) {
            addReference(argument);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return callersByTarget;
}

function trackedEnvName(value: string | undefined): string | undefined {
  return value && TRACKED_ENV_NAMES.has(value) ? value : undefined;
}

function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapStaticExpression(expression.expression);
  }
  return expression;
}

function staticStringValue(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const value = unwrapStaticExpression(expression);
  if (depth >= MAX_LOCAL_ALIAS_DEPTH) return undefined;
  const literal = stringLiteralValue(value);
  if (literal !== undefined) return literal;
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(checker, value.left, depth + 1, seen);
    const right = staticStringValue(checker, value.right, depth + 1, seen);
    return left !== undefined && right !== undefined ? `${left}${right}` : undefined;
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text;
    for (const span of value.templateSpans) {
      const spanValue = staticStringValue(checker, span.expression, depth + 1, seen);
      if (spanValue === undefined) return undefined;
      result += `${spanValue}${span.literal.text}`;
    }
    return result;
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const constantValue = checker.getConstantValue(value);
    if (typeof constantValue === 'string') return constantValue;
  }
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(value));
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      return staticStringValue(checker, declaration.initializer, depth + 1, seen);
    }
    if (ts.isPropertyAssignment(declaration)) {
      return staticStringValue(checker, declaration.initializer, depth + 1, seen);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return staticStringValue(
        checker,
        declaration.objectAssignmentInitializer ?? declaration.name,
        depth + 1,
        seen,
      );
    }
    if (ts.isEnumMember(declaration) && declaration.initializer) {
      return staticStringValue(checker, declaration.initializer, depth + 1, seen);
    }
  }
  return undefined;
}

function envAccessName(
  checker: ts.TypeChecker,
  node: ts.Node,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return trackedEnvName(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const staticName = staticStringValue(checker, node.argumentExpression);
    if (staticName !== undefined) return trackedEnvName(staticName);
    if (ts.isIdentifier(node.argumentExpression)) {
      return ROOT_ENV_CONSTANT_NAMES.get(node.argumentExpression.text);
    }
  }
  if (ts.isBindingElement(node)) {
    const property = node.propertyName;
    const name = property
      ? staticPropertyName(property, checker)
      : ts.isIdentifier(node.name)
        ? node.name.text
        : undefined;
    return trackedEnvName(name);
  }
  return undefined;
}

function environmentPropertyName(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return staticStringValue(checker, expression.argumentExpression);
  }
  return undefined;
}

function isNodeProcessReference(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(expression));
  return (
    symbol?.getName() === 'process' &&
    symbol.declarations?.some(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) === true
  );
}

function isNodeProcessEnvironmentType(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  const type = checker.getTypeAtLocation(expression);
  const symbol = resolveAlias(checker, type.aliasSymbol ?? type.getSymbol());
  return (
    symbol?.getName() === 'ProcessEnv' &&
    symbol.declarations?.some(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    ) === true
  );
}

function bindingElementPropertyName(
  checker: ts.TypeChecker,
  node: ts.BindingElement,
): string | undefined {
  const property = node.propertyName;
  if (property) return staticPropertyName(property, checker);
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function bindingElementInitializer(
  node: ts.BindingElement,
): ts.Expression | undefined {
  const pattern = node.parent;
  const declaration = ts.isObjectBindingPattern(pattern)
    ? pattern.parent
    : undefined;
  return declaration &&
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
    ? declaration.initializer
    : undefined;
}

function isAmbientProcessContainer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (isNodeProcessReference(checker, expression)) return true;
  if (depth >= MAX_LOCAL_ALIAS_DEPTH) return false;
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer &&
      isAmbientProcessContainer(
        checker,
        declaration.initializer,
        depth + 1,
        seen,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isAmbientEnvironmentContainer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (isNodeProcessEnvironmentType(checker, expression)) return true;
  if (
    environmentPropertyName(checker, expression) === 'env' &&
    (ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)) &&
    isAmbientProcessContainer(checker, expression.expression, depth, seen)
  ) {
    return true;
  }
  if (depth >= MAX_LOCAL_ALIAS_DEPTH) return false;
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer &&
      isAmbientEnvironmentContainer(
        checker,
        declaration.initializer,
        depth + 1,
        seen,
      )
    ) {
      return true;
    }
    if (
      ts.isBindingElement(declaration) &&
      bindingElementPropertyName(checker, declaration) === 'env'
    ) {
      const initializer = bindingElementInitializer(declaration);
      if (
        initializer &&
        isAmbientProcessContainer(checker, initializer, depth + 1, seen)
      )
        return true;
    }
  }
  return false;
}

function isAmbientEnvironmentAccess(
  checker: ts.TypeChecker,
  node: ts.Node,
): boolean {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    return isAmbientEnvironmentContainer(checker, node.expression);
  }
  if (!ts.isBindingElement(node)) return false;
  const initializer = bindingElementInitializer(node);
  return (
    initializer !== undefined &&
    isAmbientEnvironmentContainer(checker, initializer)
  );
}

function directEnvAccessKinds(node: ts.Node): Array<'read' | 'write'> {
  const parent = node.parent;
  if (ts.isDeleteExpression(parent)) return ['write'];
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? ['write']
      : ['read', 'write'];
  }
  return ['read'];
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${position.line + 1}:${position.character + 1}`;
}

function sourceRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): `${number}:${number}-${number}:${number}` {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`;
}

function collectDirectEnvAccesses(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  definitionForNode: Map<ts.Node, Definition>,
): DirectEnvAccess[] {
  const accesses: DirectEnvAccess[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      const envName = envAccessName(checker, node);
      if (envName && isAmbientEnvironmentAccess(checker, node)) {
        const definition = enclosingDefinition(node, definitionForNode);
        assert.ok(
          definition,
          `${envName} access outside a named production symbol at ${path}`,
        );
        for (const access of directEnvAccessKinds(node)) {
          accesses.push({
            envName,
            access,
            key: definition.key,
            path,
            symbol: definition.symbol,
            location: sourceLocation(sourceFile, node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return accesses;
}

function collectDynamicEnvironmentAccesses(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  definitionForNode: Map<ts.Node, Definition>,
): DynamicEnvironmentAccess[] {
  const accesses: DynamicEnvironmentAccess[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        staticStringValue(checker, node.argumentExpression) === undefined &&
        isAmbientEnvironmentAccess(checker, node)
      ) {
        const definition = enclosingDefinition(node, definitionForNode);
        assert.ok(
          definition,
          `dynamic environment access outside a named production symbol at ${path}`,
        );
        accesses.push({
          key: definition.key,
          path,
          symbol: definition.symbol,
          sourceRange: sourceRange(sourceFile, node),
          targetText: node.argumentExpression.getText(sourceFile),
          node,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return accesses;
}

function stringLiteralValue(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function constructsDotOmxStatePath(node: ts.CallExpression): boolean {
  const calleeName = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : '';
  if (calleeName !== 'join' && calleeName !== 'resolve') return false;
  const values = node.arguments.map(stringLiteralValue);
  if (values.some((value) => value?.replace(/\\/g, '/').includes('.omx/state')))
    return true;
  const omxIndex = values.findIndex((value) => value === '.omx');
  return (
    omxIndex >= 0 &&
    values.slice(omxIndex + 1).some((value) => value === 'state')
  );
}

function objectPropertyInitializer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const propertyName = staticMemberName(expression, checker);
  if (!propertyName) return undefined;
  const objectSymbol = resolveAlias(
    checker,
    checker.getSymbolAtLocation(expression.expression),
  );
  if (!objectSymbol) return undefined;
  for (const declaration of objectSymbol.declarations ?? []) {
    if (
      !ts.isVariableDeclaration(declaration) ||
      !isConstVariableDeclaration(declaration) ||
      !declaration.initializer
    ) {
      continue;
    }
    const object = unwrapStaticExpression(declaration.initializer);
    if (!ts.isObjectLiteralExpression(object)) continue;
    for (const property of object.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        staticPropertyName(property.name, checker) === propertyName
      ) {
        return property.initializer;
      }
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === propertyName
      ) {
        return property.objectAssignmentInitializer ?? property.name;
      }
    }
  }
  return undefined;
}

function isDefaultedDependencyCallable(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  propertyAssignments: ReadonlyMap<ts.Symbol, ts.Expression | undefined>,
): boolean {
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(expression));
  const initializer =
    (symbol && callableInitializer(symbol, propertyAssignments)) ??
    objectPropertyInitializer(checker, expression);
  const value = initializer && unwrapStaticExpression(initializer);
  if (
    !value ||
    !ts.isBinaryExpression(value) ||
    value.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const injected = unwrapStaticExpression(value.left);
  return (
    ts.isPropertyAccessExpression(injected) &&
    ts.isIdentifier(injected.expression) &&
    injected.expression.text === 'deps'
  );
}

function collectDirectStatePathConstructions(
  root: string,
  program: ts.Program,
  definitionForNode: Map<ts.Node, Definition>,
): DirectStatePathConstruction[] {
  const constructions: DirectStatePathConstruction[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && constructsDotOmxStatePath(node)) {
        const definition = enclosingDefinition(node, definitionForNode);
        assert.ok(
          definition,
          `.omx/state construction outside a named production symbol at ${path}`,
        );
        constructions.push({
          key: definition.key,
          path,
          symbol: definition.symbol,
          location: sourceLocation(sourceFile, node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return constructions;
}

function collectDynamicAuthorityCalls(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  definitionForNode: Map<ts.Node, Definition>,
): DynamicAuthorityCall[] {
  const calls: DynamicAuthorityCall[] = [];
  const propertyAssignments = collectStaticPropertyAssignments(
    root,
    program,
    checker,
  );
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const dynamicElementAccess =
        ts.isElementAccessExpression(node.expression) &&
        stringLiteralValue(node.expression.argumentExpression) === undefined;
      const defaultedDependencyCall = isDefaultedDependencyCallable(
        checker,
        node.expression,
        propertyAssignments,
      );
      if (!dynamicElementAccess && !defaultedDependencyCall) {
        ts.forEachChild(node, visit);
        return;
      }
      const targetText =
        dynamicElementAccess && ts.isElementAccessExpression(node.expression)
          ? node.expression.expression.getText(sourceFile)
          : node.expression.getText(sourceFile);
      if (
        /(?:authority|runsRoot|state(?:Dir|Path)|omxRoot|registry)/i.test(
          targetText,
        )
      ) {
        const definition = enclosingDefinition(node, definitionForNode);
        assert.ok(
          definition,
          `dynamic authority call outside a named production symbol at ${path}`,
        );
        calls.push({
          key: definition.key,
          path,
          symbol: definition.symbol,
          sourceRange: sourceRange(sourceFile, node),
          targetText,
          node,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function collectUnresolvedAuthorityCalls(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  definitionForNode: Map<ts.Node, Definition>,
  definitionForSymbol: Map<ts.Symbol, Definition>,
): UnresolvedAuthorityCall[] {
  const calls: UnresolvedAuthorityCall[] = [];
  const propertyAssignments = collectStaticPropertyAssignments(
    root,
    program,
    checker,
  );
  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(root, sourceFile)) continue;
    const path = normalizeRepoPath(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (
        ts.isElementAccessExpression(node.expression) &&
        stringLiteralValue(node.expression.argumentExpression) === undefined
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const targetText = node.expression.getText(sourceFile);
      const targetSymbol = getCallTargetSymbol(
        checker,
        node.expression,
        propertyAssignments,
      );
      const target = definitionForResolvedSymbol(
        targetSymbol,
        definitionForSymbol,
      );
      const calleeName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : '';
      const isAuthorityRelevant =
        AUTHORITY_RELEVANT_CALL_PATTERN.test(calleeName);
      const defaultedDependencyCall = isDefaultedDependencyCallable(
        checker,
        node.expression,
        propertyAssignments,
      );
      if (!isAuthorityRelevant || target || defaultedDependencyCall) {
        ts.forEachChild(node, visit);
        return;
      }
      const definition = enclosingDefinition(node, definitionForNode);
      assert.ok(
        definition,
        `unresolved authority call outside a named production symbol at ${path}`,
      );
      calls.push({
        key: definition.key,
        path,
        symbol: definition.symbol,
        location: sourceLocation(sourceFile, node),
        targetText,
      });
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

function buildCalleeGraph(
  callersByTarget: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const calleesByCaller = new Map<string, Set<string>>();
  for (const [target, callers] of callersByTarget) {
    for (const caller of callers) {
      const callees = calleesByCaller.get(caller) ?? new Set<string>();
      callees.add(target);
      calleesByCaller.set(caller, callees);
    }
  }
  return calleesByCaller;
}

function findBoundedCallPath(
  calleesByCaller: Map<string, Set<string>>,
  source: string,
  targets: ReadonlySet<string>,
): string[] | undefined {
  if (targets.has(source)) return [source];
  const queue: Array<{ key: string; depth: number; path: string[] }> = [
    { key: source, depth: 0, path: [source] },
  ];
  const seen = new Set<string>([source]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_CALLER_DEPTH) continue;
    for (const target of [...(calleesByCaller.get(current.key) ?? [])].sort()) {
      const path = [...current.path, target];
      if (targets.has(target)) return path;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push({ key: target, depth: current.depth + 1, path });
      }
    }
  }
  return undefined;
}

function findBoundedReverseCallers(
  callersByTarget: Map<string, Set<string>>,
  source: string,
): Set<string> {
  const callers = new Set<string>();
  const queue: Array<{ key: string; depth: number }> = [
    { key: source, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_CALLER_DEPTH) continue;
    for (const caller of [...(callersByTarget.get(current.key) ?? [])].sort()) {
      if (callers.has(caller)) continue;
      callers.add(caller);
      queue.push({ key: caller, depth: current.depth + 1 });
    }
  }
  return callers;
}

function validateAuthorityCallsiteInventory(
  input: AuthorityInventoryValidationInput,
): string[] {
  const violations: string[] = [];
  const inventory = buildInventoryMap(input.inventory, violations);
  const checker = input.program.getTypeChecker();
  const { definitionForNode, definitionForSymbol, definitionsByKey } =
    collectDefinitions(input.root, input.program, checker);

  for (const entry of input.inventory) {
    const key = inventoryKey(entry);
    const sourceFile = findSourceFile(input.program, input.root, entry.path);
    if (!sourceFile) {
      violations.push(`[stale-inventory-path] ${entry.path}`);
      continue;
    }
    const definitions = definitionsByKey.get(key) ?? [];
    if (
      definitions.length === 0 &&
      !sourceContainsExportSpecifier(sourceFile, entry.symbol)
    ) {
      violations.push(`[stale-inventory-symbol] ${key}`);
    }
  }

  const directEnvAccesses = collectDirectEnvAccesses(
    input.root,
    input.program,
    checker,
    definitionForNode,
  );
  const ambientRootReads = directEnvAccesses.filter(
    (access) => access.access === 'read' && ROOT_ENV_NAMES.has(access.envName),
  );
  if (input.requireAmbientRootReader && ambientRootReads.length === 0) {
    violations.push(
      '[missing-ambient-root-reader] production scan found no ambient root reader',
    );
  }
  for (const access of ambientRootReads) {
    const row = inventory.get(access.key);
    if (!row) {
      violations.push(
        `[unclassified-ambient-root-reader] ${access.envName} ${access.key}@${access.location}`,
      );
    } else if (row.classification !== 'bootstrap-only') {
      violations.push(
        `[ambient-root-reader-not-bootstrap] ${access.envName} ${access.key}@${access.location}`,
      );
    }
  }
  if (input.requireTransportAccess && directEnvAccesses.length === 0) {
    violations.push(
      '[missing-transport-access] production scan found no authority transport access',
    );
  }
  if (
    input.requireTransportAccess &&
    !directEnvAccesses.some(
      (access) =>
        access.access === 'write' &&
        AUTHORITY_TRANSPORT_ENV_NAMES.has(access.envName),
    )
  ) {
    violations.push(
      '[missing-transport-writer] production scan found no child-transport writer',
    );
  }
  for (const access of directEnvAccesses) {
    if (!inventory.has(access.key)) {
      violations.push(
        `[unclassified-env-access] ${access.envName} ${access.access} ${access.key}@${access.location}`,
      );
    }
  }

  const dynamicEnvironmentAccesses = collectDynamicEnvironmentAccesses(
    input.root,
    input.program,
    checker,
    definitionForNode,
  );
  const dynamicEnvironmentByWaiverKey = new Map<
    string,
    DynamicEnvironmentAccess[]
  >();
  for (const access of dynamicEnvironmentAccesses) {
    const key = `${access.path}::${access.symbol}::${access.sourceRange}`;
    const bucket = dynamicEnvironmentByWaiverKey.get(key) ?? [];
    bucket.push(access);
    dynamicEnvironmentByWaiverKey.set(key, bucket);
  }
  const usedDynamicEnvironmentWaivers = new Set<string>();
  for (const waiver of input.dynamicEnvironmentWaivers) {
    const waiverKey = `${waiver.path}::${waiver.symbol}::${waiver.source_range}`;
    if (usedDynamicEnvironmentWaivers.has(waiverKey)) {
      violations.push(`[duplicate-dynamic-environment-waiver] ${waiverKey}`);
    }
    usedDynamicEnvironmentWaivers.add(waiverKey);
    if (!/^src\/.+\.ts$/.test(waiver.path)) {
      violations.push(`[invalid-dynamic-environment-waiver-path] ${waiver.path}`);
    }
    if (!/^\d+:\d+-\d+:\d+$/.test(waiver.source_range)) {
      violations.push(`[invalid-dynamic-environment-waiver-range] ${waiverKey}`);
    }
    if (!waiver.target_text.trim()) {
      violations.push(`[missing-dynamic-environment-waiver-target] ${waiverKey}`);
    }
    if (!waiver.owner.trim()) {
      violations.push(`[missing-dynamic-environment-waiver-owner] ${waiverKey}`);
    }
    if (!waiver.rationale.trim()) {
      violations.push(`[missing-dynamic-environment-waiver-rationale] ${waiverKey}`);
    }
    if (!waiver.migration_phase.trim()) {
      violations.push(`[missing-dynamic-environment-waiver-phase] ${waiverKey}`);
    }
    if (!waiver.expiry_or_removal_condition.trim()) {
      violations.push(`[missing-dynamic-environment-waiver-expiry] ${waiverKey}`);
    }

    const row = inventory.get(`${waiver.path}::${waiver.symbol}`);
    if (!row) {
      violations.push(
        `[dynamic-environment-waiver-without-inventory-row] ${waiverKey}`,
      );
    } else {
      if (waiver.classification !== row.classification) {
        violations.push(
          `[dynamic-environment-waiver-classification-drift] ${waiverKey}`,
        );
      }
      if (waiver.owner !== row.owner) {
        violations.push(`[dynamic-environment-waiver-owner-drift] ${waiverKey}`);
      }
      if (waiver.migration_phase !== row.migration_phase) {
        violations.push(`[dynamic-environment-waiver-phase-drift] ${waiverKey}`);
      }
    }

    const definitions =
      definitionsByKey.get(`${waiver.path}::${waiver.symbol}`) ?? [];
    if (definitions.length !== 1) {
      violations.push(`[stale-dynamic-environment-waiver-symbol] ${waiverKey}`);
    }
    const accesses = dynamicEnvironmentByWaiverKey.get(waiverKey) ?? [];
    if (accesses.length !== 1) {
      violations.push(
        `[stale-or-broad-dynamic-environment-waiver] ${waiverKey}`,
      );
    }
    const access = accesses[0];
    if (access && definitions[0]) {
      if (
        access.node.getStart() < definitions[0].node.getStart() ||
        access.node.getEnd() > definitions[0].node.getEnd()
      ) {
        violations.push(
          `[dynamic-environment-waiver-outside-symbol] ${waiverKey}`,
        );
      }
      if (waiver.target_text !== access.targetText) {
        violations.push(
          `[dynamic-environment-waiver-target-drift] ${waiverKey} (${access.targetText})`,
        );
      }
    }
  }
  for (const access of dynamicEnvironmentAccesses) {
    const key = `${access.path}::${access.symbol}::${access.sourceRange}`;
    if (!usedDynamicEnvironmentWaivers.has(key)) {
      violations.push(
        `[unwaived-dynamic-environment-access] ${key} (${access.targetText})`,
      );
    }
  }

  for (const key of input.requiredTransportWriterKeys ?? []) {
    const row = inventory.get(key);
    if (!row) {
      violations.push(`[missing-postcommit-transport-row] ${key}`);
    } else {
      if (row.classification !== 'authority-context') {
        violations.push(`[postcommit-transport-not-authority-context] ${key}`);
      }
      if (!input.helperKeys.includes(key)) {
        violations.push(`[postcommit-transport-not-helper-seed] ${key}`);
      }
    }
  }

  const directStatePaths = collectDirectStatePathConstructions(
    input.root,
    input.program,
    definitionForNode,
  );
  if (input.requireStatePathConstruction && directStatePaths.length === 0) {
    violations.push(
      '[missing-state-path-construction] production scan found no .omx/state builder',
    );
  }
  for (const construction of directStatePaths) {
    if (!inventory.has(construction.key)) {
      violations.push(
        `[unclassified-state-path-builder] ${construction.key}@${construction.location}`,
      );
    }
  }

  const callersByTarget = buildCallerGraph(
    input.root,
    input.program,
    checker,
    definitionForNode,
    definitionForSymbol,
  );
  const boundaries = new Set(input.boundaryKeys);
  if (new Set(input.helperKeys).size !== input.helperKeys.length) {
    violations.push('[duplicate-authority-helper-seed]');
  }
  if (boundaries.size !== input.boundaryKeys.length) {
    violations.push('[duplicate-authority-boundary]');
  }
  for (const boundary of boundaries) {
    if (!inventory.has(boundary))
      violations.push(`[boundary-without-inventory-row] ${boundary}`);
    if (input.helperKeys.includes(boundary))
      violations.push(`[boundary-is-helper-seed] ${boundary}`);
  }

  const queue = input.helperKeys.map((key) => ({ key, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.key)) continue;
    seen.add(current.key);
    if (current.depth === 0 && !inventory.has(current.key)) {
      violations.push(`[helper-without-inventory-row] ${current.key}`);
    }
    const definitions = definitionsByKey.get(current.key) ?? [];
    if (definitions.length === 0) {
      const [path, symbol] = current.key.split('::');
      const sourceFile =
        path && findSourceFile(input.program, input.root, path);
      if (
        !sourceFile ||
        !symbol ||
        !sourceContainsExportSpecifier(sourceFile, symbol)
      ) {
        violations.push(`[missing-helper-definition] ${current.key}`);
      }
      continue;
    }
    for (const caller of callersByTarget.get(current.key) ?? []) {
      if (!inventory.has(caller)) {
        violations.push(`[unclassified-caller] ${caller} -> ${current.key}`);
        continue;
      }
      if (!boundaries.has(caller)) {
        if (current.depth >= MAX_CALLER_DEPTH) {
          violations.push(
            `[caller-depth-exceeded] ${caller} -> ${current.key}`,
          );
        } else {
          queue.push({ key: caller, depth: current.depth + 1 });
        }
      }
    }
  }

  const calleesByCaller = buildCalleeGraph(callersByTarget);
  const phase2TransportTargets = new Set(
    [...inventory.entries()]
      .filter(
        ([, entry]) => entry.migration_phase === POSTCOMMIT_TRANSPORT_PHASE,
      )
      .map(([key]) => key),
  );
  for (const precommitKey of input.precommitKeys ?? []) {
    const path = findBoundedCallPath(
      calleesByCaller,
      precommitKey,
      phase2TransportTargets,
    );
    if (!path || path.length < 2) continue;
    const target = path[path.length - 1]!;
    if (path.length === 2) {
      violations.push(
        `[precommit-transport-edge] ${precommitKey} -> ${target}`,
      );
    } else {
      violations.push(
        `[precommit-transport-reachability] ${path.join(' -> ')}`,
      );
    }
  }

  const registryCandidateHelpers = new Set(
    input.registryCandidateHelperKeys ?? [],
  );
  const validationBoundaries = new Set(input.validationBoundaryKeys ?? []);
  if (
    registryCandidateHelpers.size !==
    (input.registryCandidateHelperKeys ?? []).length
  ) {
    violations.push('[duplicate-registry-candidate-helper]');
  }
  if (
    validationBoundaries.size !== (input.validationBoundaryKeys ?? []).length
  ) {
    violations.push('[duplicate-validation-boundary-helper]');
  }
  for (const helperKey of registryCandidateHelpers) {
    const helper = inventory.get(helperKey);
    if (!helper) {
      violations.push(
        `[registry-candidate-without-inventory-row] ${helperKey}`,
      );
    } else {
      if (helper.classification !== 'bootstrap-only') {
        violations.push(`[registry-candidate-not-bootstrap] ${helperKey}`);
      }
      if (!input.helperKeys.includes(helperKey)) {
        violations.push(`[registry-candidate-not-helper-seed] ${helperKey}`);
      }
    }
  }
  for (const validatorKey of validationBoundaries) {
    const validator = inventory.get(validatorKey);
    if (!validator) {
      violations.push(
        `[validation-boundary-without-inventory-row] ${validatorKey}`,
      );
    } else {
      if (
        validator.classification !== 'authority-context' ||
        validator.migration_phase === 'phase-0-inventory-and-denial'
      ) {
        violations.push(
          `[validation-boundary-not-authority-context] ${validatorKey}`,
        );
      }
      if (!input.helperKeys.includes(validatorKey)) {
        violations.push(
          `[validation-boundary-not-helper-seed] ${validatorKey}`,
        );
      }
    }
  }
  for (const helperKey of registryCandidateHelpers) {
    for (const caller of findBoundedReverseCallers(
      callersByTarget,
      helperKey,
    )) {
      const callerRow = inventory.get(caller);
      if (callerRow?.classification !== 'authority-context') continue;
      const missingValidators = [...validationBoundaries].filter(
        (validatorKey) =>
          !findBoundedCallPath(
            calleesByCaller,
            caller,
            new Set([validatorKey]),
          ),
      );
      if (validationBoundaries.size === 0 || missingValidators.length > 0) {
        violations.push(
          `[missing-validation-boundary] ${caller} -> ${helperKey} (${missingValidators.join(', ') || 'no concrete validator'}; caller callees: ${[...(calleesByCaller.get(caller) ?? [])].sort().join(', ') || 'none'}; helper callees: ${[...(calleesByCaller.get(helperKey) ?? [])].sort().join(', ') || 'none'})`,
        );
      }
    }
  }

  const dynamicCalls = collectDynamicAuthorityCalls(
    input.root,
    input.program,
    checker,
    definitionForNode,
  );
  const dynamicByWaiverKey = new Map<string, DynamicAuthorityCall[]>();
  for (const call of dynamicCalls) {
    const key = `${call.path}::${call.symbol}::${call.sourceRange}`;
    const bucket = dynamicByWaiverKey.get(key) ?? [];
    bucket.push(call);
    dynamicByWaiverKey.set(key, bucket);
  }
  const usedWaivers = new Set<string>();
  for (const waiver of input.dynamicWaivers) {
    const waiverKey = `${waiver.path}::${waiver.symbol}::${waiver.source_range}`;
    if (usedWaivers.has(waiverKey))
      violations.push(`[duplicate-dynamic-waiver] ${waiverKey}`);
    usedWaivers.add(waiverKey);
    if (!/^src\/.+\.ts$/.test(waiver.path))
      violations.push(`[invalid-dynamic-waiver-path] ${waiver.path}`);
    if (!/^\d+:\d+-\d+:\d+$/.test(waiver.source_range))
      violations.push(`[invalid-dynamic-waiver-range] ${waiverKey}`);
    if (waiver.bounded_targets.length === 0)
      violations.push(`[unbounded-dynamic-waiver] ${waiverKey}`);
    if (
      new Set(waiver.bounded_targets).size !== waiver.bounded_targets.length
    ) {
      violations.push(`[duplicate-dynamic-waiver-target] ${waiverKey}`);
    }
    for (const target of waiver.bounded_targets) {
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(target)) {
        violations.push(
          `[invalid-dynamic-waiver-target] ${waiverKey} (${target})`,
        );
      }
    }
    if (!waiver.owner.trim())
      violations.push(`[missing-dynamic-waiver-owner] ${waiverKey}`);
    if (!waiver.rationale.trim())
      violations.push(`[missing-dynamic-waiver-rationale] ${waiverKey}`);
    if (!waiver.migration_phase.trim())
      violations.push(`[missing-dynamic-waiver-phase] ${waiverKey}`);
    if (!waiver.expiry_or_removal_condition.trim())
      violations.push(`[missing-dynamic-waiver-expiry] ${waiverKey}`);

    const row = inventory.get(`${waiver.path}::${waiver.symbol}`);
    if (!row) {
      violations.push(`[dynamic-waiver-without-inventory-row] ${waiverKey}`);
    } else {
      if (waiver.classification !== row.classification)
        violations.push(`[dynamic-waiver-classification-drift] ${waiverKey}`);
      if (waiver.owner !== row.owner)
        violations.push(`[dynamic-waiver-owner-drift] ${waiverKey}`);
      if (waiver.migration_phase !== row.migration_phase)
        violations.push(`[dynamic-waiver-phase-drift] ${waiverKey}`);
    }

    const definitions =
      definitionsByKey.get(`${waiver.path}::${waiver.symbol}`) ?? [];
    if (definitions.length !== 1)
      violations.push(`[stale-dynamic-waiver-symbol] ${waiverKey}`);
    const calls = dynamicByWaiverKey.get(waiverKey) ?? [];
    if (calls.length !== 1)
      violations.push(`[stale-or-broad-dynamic-waiver] ${waiverKey}`);
    const call = calls[0];
    if (call && definitions[0]) {
      if (
        call.node.getStart() < definitions[0].node.getStart() ||
        call.node.getEnd() > definitions[0].node.getEnd()
      ) {
        violations.push(`[dynamic-waiver-outside-symbol] ${waiverKey}`);
      }
      if (!waiver.bounded_targets.includes(call.targetText)) {
        violations.push(
          `[dynamic-waiver-target-drift] ${waiverKey} (${call.targetText})`,
        );
      }
    }
  }
  for (const call of dynamicCalls) {
    const key = `${call.path}::${call.symbol}::${call.sourceRange}`;
    if (!usedWaivers.has(key)) {
      violations.push(
        `[unwaived-dynamic-authority-call] ${key} (${call.targetText})`,
      );
    }
  }

  for (const call of collectUnresolvedAuthorityCalls(
    input.root,
    input.program,
    checker,
    definitionForNode,
    definitionForSymbol,
  )) {
    violations.push(
      `[unresolved-authority-call] ${call.key}@${call.location} (${call.targetText})`,
    );
  }
  return violations;
}

function assertAuthorityCallsiteInventoryValid(
  input: AuthorityInventoryValidationInput,
): void {
  const violations = validateAuthorityCallsiteInventory(input);
  assert.deepEqual(
    violations,
    [],
    `authority callsite inventory violations:\n${violations.join('\n')}`,
  );
}

function productionValidationInput(
  root: string,
  program: ts.Program,
): AuthorityInventoryValidationInput {
  return {
    root,
    program,
    inventory: AUTHORITY_CALLSITE_INVENTORY,
    dynamicWaivers: AUTHORITY_DYNAMIC_CALL_WAIVERS,
    dynamicEnvironmentWaivers: AUTHORITY_DYNAMIC_ENV_ACCESS_WAIVERS,
    helperKeys: AUTHORITY_TRANSITIVE_HELPER_KEYS,
    boundaryKeys: AUTHORITY_TRANSITIVE_BOUNDARY_KEYS,
    requiredTransportWriterKeys: POSTCOMMIT_TRANSPORT_WRITER_KEYS,
    precommitKeys: [
      'src/state/authority.ts::initializeStateAuthority',
      'src/state/authority.ts::rolloverStateAuthorityToAlternateRoot',
      'src/cli/index.ts::establishLaunchAuthority',
    ],
    registryCandidateHelperKeys: AUTHORITY_REGISTRY_CANDIDATE_HELPER_KEYS,
    validationBoundaryKeys: AUTHORITY_VALIDATION_BOUNDARY_KEYS,
    requireAmbientRootReader: true,
    requireTransportAccess: true,
    requireStatePathConstruction: true,
  };
}

function fixtureEntry(
  path: string,
  symbol: string,
  classification: AuthorityCallsiteClassification,
  migration_phase: string,
  rationale: string,
): AuthorityCallsiteInventoryEntry {
  return {
    path,
    symbol,
    classification,
    owner: 'authority-inventory-test',
    rationale,
    migration_phase,
  };
}

function assertMutationViolation(
  files: Record<string, string>,
  inventory: readonly AuthorityCallsiteInventoryEntry[],
  helperKeys: readonly string[],
  expectedViolation: RegExp,
  precommitKeys: readonly string[] = [],
  registryCandidateHelperKeys: readonly string[] = [],
  validationBoundaryKeys: readonly string[] = [],
): void {
  const { root, program } = createMutationFixtureProgram(files);
  try {
    assert.throws(
      () =>
        assertAuthorityCallsiteInventoryValid({
        root,
        program,
        inventory,
        dynamicWaivers: [],
        dynamicEnvironmentWaivers: [],
        helperKeys,
        boundaryKeys: [],
        precommitKeys,
          registryCandidateHelperKeys,
          validationBoundaryKeys,
      }),
      expectedViolation,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('authority callsite inventory', () => {
  it('validates the production program and inventory with zero violations', () => {
    const root = repoRoot();
    const program = createProductionProgram(root);
    assert.deepEqual(
      validateAuthorityCallsiteInventory(
        productionValidationInput(root, program),
      ),
      [],
    );
  });

  it('rejects an unclassified indirect local-alias wrapper', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          "export function resolveRegistryCandidate(): string { return '/tmp/runs'; }\n",
        'src/callers.ts': [
          "import { resolveRegistryCandidate } from './helpers.js';",
          'export function indirectWrapper(): string { const localResolver = resolveRegistryCandidate; return localResolver(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*indirectWrapper/,
    );
  });

  it('rejects an unclassified renamed re-export alias', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          "export function resolveRegistryCandidate(): string { return '/tmp/runs'; }\n",
        'src/reexport.ts':
          "export { resolveRegistryCandidate as renamedCandidate } from './helpers.js';\n",
        'src/callers.ts': [
          "import { renamedCandidate } from './reexport.js';",
          'export function reexportAliasCaller(): string { return renamedCandidate(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*reexportAliasCaller/,
    );
  });

  it('rejects an unclassified namespace callback call', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          "export function resolveRegistryCandidate(): string { return '/tmp/runs'; }\n",
        'src/callers.ts': [
          "import * as helpers from './helpers.js';",
          'function invoke(callback: () => string): string { return callback(); }',
          'export function namespaceCaller(): string { return invoke(helpers.resolveRegistryCandidate); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*namespaceCaller/,
    );
  });

  it('rejects a registry candidate caller when rationale prose claims validation without a concrete validator path', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          "export function resolveRegistryCandidate(): string { return '/tmp/runs'; }\n",
        'src/callers.ts': [
          "import { resolveRegistryCandidate } from './helpers.js';",
          'export function consumeRegistryCandidate(): string { return resolveRegistryCandidate(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
        fixtureEntry(
          'src/callers.ts',
          'consumeRegistryCandidate',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Carries a registry candidate after committed validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[missing-validation-boundary\].*consumeRegistryCandidate/,
      [],
      ['src/helpers.ts::resolveRegistryCandidate'],
    );
  });

  it('rejects an unresolved computed dynamic authority call without an exact waiver', () => {
    assertMutationViolation(
      {
        'src/callers.ts': [
          "const authorityOps = { dynamic(): string { return '/tmp/state'; } };",
          "export function unwaivedDynamic(): string { const operation = 'dynamic'; return authorityOps[operation](); }",
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/callers.ts',
          'unwaivedDynamic',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Uses a committed authority operation.',
        ),
      ],
      [],
      /\[unwaived-dynamic-authority-call\].*unwaivedDynamic/,
    );
  });

  it('rejects a direct precommit caller that reaches child transport construction', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          'export function buildStateAuthorityTransportEnv(): Record<string, string> { return {}; }\n',
        'src/callers.ts': [
          "import { buildStateAuthorityTransportEnv } from './helpers.js';",
          'export function precommitTransportCaller(): Record<string, string> { return buildStateAuthorityTransportEnv(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'buildStateAuthorityTransportEnv',
          'authority-context',
          'phase-2-postcommit-transport',
          'Builds child transport from committed authority.',
        ),
        fixtureEntry(
          'src/callers.ts',
          'precommitTransportCaller',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Performs authority establishment before commit.',
        ),
      ],
      ['src/helpers.ts::buildStateAuthorityTransportEnv'],
      /\[precommit-transport-edge\].*precommitTransportCaller/,
      ['src/callers.ts::precommitTransportCaller'],
    );
  });

  it('rejects an unclassified direct caller of the raw child bearer accessor', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          'export function stateAuthorityTransportCapabilityForChild(): string { return "bearer"; }\n',
        'src/callers.ts': [
          "import { stateAuthorityTransportCapabilityForChild } from './helpers.js';",
          'export function leakChildBearer(): string { return stateAuthorityTransportCapabilityForChild(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'stateAuthorityTransportCapabilityForChild',
          'authority-context',
          'phase-2-postcommit-transport',
          'Returns a process-local bearer only after committed authority validation.',
        ),
      ],
      ['src/helpers.ts::stateAuthorityTransportCapabilityForChild'],
      /\[unclassified-caller\].*leakChildBearer/,
    );
  });

  it('rejects a renamed and destructured process-environment alias without an inventory row', () => {
    assertMutationViolation(
      {
        'src/globals.d.ts': [
          'declare namespace NodeJS { interface ProcessEnv { OMX_RUNS_DIR?: string; } }',
          'declare const process: { env: NodeJS.ProcessEnv };',
        ].join('\n'),
        'src/callers.ts': [
          'export function readRenamedEnvironmentAlias(): string {',
          '  const processAlias = process;',
          '  const { env: inheritedEnvironment } = processAlias;',
          "  return inheritedEnvironment.OMX_RUNS_DIR ?? '';",
          '}',
        ].join('\n'),
      },
      [],
      [],
      /\[unclassified-ambient-root-reader\] OMX_RUNS_DIR.*readRenamedEnvironmentAlias/,
    );
  });

  it('rejects a multi-hop precommit wrapper that reaches postcommit transport construction', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          'export function buildStateAuthorityTransportEnv(): Record<string, string> { return {}; }\n',
        'src/callers.ts': [
          "import { buildStateAuthorityTransportEnv } from './helpers.js';",
          'export function precommitTransportIntermediate(): Record<string, string> { return buildStateAuthorityTransportEnv(); }',
          'export function precommitTransportCaller(): Record<string, string> { return precommitTransportIntermediate(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'buildStateAuthorityTransportEnv',
          'authority-context',
          'phase-2-postcommit-transport',
          'Builds child transport from committed authority.',
        ),
        fixtureEntry(
          'src/callers.ts',
          'precommitTransportIntermediate',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Delegates a precommit authority establishment step.',
        ),
        fixtureEntry(
          'src/callers.ts',
          'precommitTransportCaller',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Performs authority establishment before commit.',
        ),
      ],
      ['src/helpers.ts::buildStateAuthorityTransportEnv'],
      /\[precommit-transport-reachability\].*precommitTransportCaller.*precommitTransportIntermediate.*buildStateAuthorityTransportEnv/,
      ['src/callers.ts::precommitTransportCaller'],
    );
  });

  it('rejects an unclassified caller of a local object-method helper', () => {
    assertMutationViolation(
      {
        'src/helpers.ts': [
          'const registryHelpers = {',
          "  resolveRegistryCandidate: (): string => '/tmp/runs',",
          '};',
          'export function callLocalObjectHelper(): string {',
          '  return registryHelpers.resolveRegistryCandidate();',
          '}',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*callLocalObjectHelper/,
    );
  });

  it('rejects an unclassified caller of an imported renamed object helper', () => {
    assertMutationViolation(
      {
        'src/helpers.ts': [
          'export const registryHelpers = {',
          "  resolveRegistryCandidate(): string { return '/tmp/runs'; },",
          '};',
        ].join('\n'),
        'src/reexport.ts':
          "export { registryHelpers as renamedRegistryHelpers } from './helpers.js';\n",
        'src/callers.ts': [
          "import { renamedRegistryHelpers } from './reexport.js';",
          'export function callImportedObjectHelper(): string {',
          '  return renamedRegistryHelpers.resolveRegistryCandidate();',
          '}',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*callImportedObjectHelper/,
    );
  });

  it('rejects an unclassified caller through a property alias', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          "export function resolveRegistryCandidate(): string { return '/tmp/runs'; }\n",
        'src/callers.ts': [
          "import { resolveRegistryCandidate } from './helpers.js';",
          'const registryHelpers = { resolveRegistryCandidate };',
          'const propertyAlias = registryHelpers.resolveRegistryCandidate;',
          'export function callPropertyAlias(): string { return propertyAlias(); }',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'resolveRegistryCandidate',
          'bootstrap-only',
          'phase-0-inventory-and-denial',
          'Locates a registry candidate before committed generation validation.',
        ),
      ],
      ['src/helpers.ts::resolveRegistryCandidate'],
      /\[unclassified-caller\].*callPropertyAlias/,
    );
  });

  it('rejects a lexical authority call that cannot resolve to a classified definition', () => {
    assertMutationViolation(
      {
        'src/callers.ts': [
          'interface AuthorityOperations { resolveAuthority(): string; }',
          'declare const authorityOperations: AuthorityOperations;',
          'export function callLexicalAuthorityOperation(): string {',
          '  return authorityOperations.resolveAuthority();',
          '}',
        ].join('\n'),
      },
      [],
      [],
      /\[unresolved-authority-call\].*callLexicalAuthorityOperation/,
    );
  });

  it('rejects an unwaived defaulted authority dependency call', () => {
    assertMutationViolation(
      {
        'src/helpers.ts':
          'export async function runAuthorityTick(): Promise<void> {}\n',
        'src/callers.ts': [
          'interface Dependencies { runAuthorityTickFn?: () => Promise<void>; }',
          'export async function callDefaultedAuthorityTick(deps: Dependencies): Promise<void> {',
          '  const runAuthorityTickFn = deps.runAuthorityTickFn ?? runAuthorityTick;',
          '  await runAuthorityTickFn();',
          '}',
        ].join('\n'),
      },
      [
        fixtureEntry(
          'src/helpers.ts',
          'runAuthorityTick',
          'authority-context',
          'phase-1-committed-authority-resolution',
          'Performs the authoritative HUD tick.',
        ),
      ],
      ['src/helpers.ts::runAuthorityTick'],
      /\[unwaived-dynamic-authority-call\].*callDefaultedAuthorityTick/,
    );
  });

  it('detects a statically computed ambient root environment key', () => {
    assertMutationViolation(
      {
        'src/globals.d.ts': [
          'declare namespace NodeJS { interface ProcessEnv { OMX_ROOT?: string; } }',
          'declare const process: { env: NodeJS.ProcessEnv };',
        ].join('\n'),
        'src/callers.ts': [
          "const prefix = 'OMX_';",
          "const rootKey = `${prefix}ROOT`;",
          'export function readStaticallyComputedRoot(): string {',
          "  return process.env[rootKey] ?? '';",
          '}',
        ].join('\n'),
      },
      [],
      [],
      /\[unclassified-ambient-root-reader\] OMX_ROOT.*readStaticallyComputedRoot/,
    );
  });

  it('rejects an unwaived dynamic ambient environment key', () => {
    assertMutationViolation(
      {
        'src/globals.d.ts': [
          'declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined; } }',
          'declare const process: { env: NodeJS.ProcessEnv };',
        ].join('\n'),
        'src/callers.ts': [
          "function runtimeKey(): string { return 'OMX_STATE_AUTHORITY_CAPABILITY'; }",
          'export function readDynamicAuthorityEnvironment(): string {',
          "  return process.env[runtimeKey()] ?? '';",
          '}',
        ].join('\n'),
      },
      [],
      [],
      /\[unwaived-dynamic-environment-access\].*readDynamicAuthorityEnvironment/,
    );
  });

  it('accepts only an exact, inventory-backed dynamic environment waiver with a rationale', () => {
    const files = {
      'src/globals.d.ts': [
        'declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined; } }',
        'declare const process: { env: NodeJS.ProcessEnv };',
      ].join('\n'),
      'src/callers.ts': [
        'export function readWaivedDynamicEnvironment(envKey: string): string {',
        "  return process.env[envKey] ?? '';",
        '}',
      ].join('\n'),
    };
    const { root, program } = createMutationFixtureProgram(files);
    try {
      assert.deepEqual(
        validateAuthorityCallsiteInventory({
          root,
          program,
          inventory: [
            fixtureEntry(
              'src/callers.ts',
              'readWaivedDynamicEnvironment',
              'out-of-scope',
              'out-of-scope-environment',
              'Reads a narrowly reviewed non-authority environment key.',
            ),
          ],
          dynamicWaivers: [],
          dynamicEnvironmentWaivers: [
            {
              path: 'src/callers.ts',
              symbol: 'readWaivedDynamicEnvironment',
              source_range: '2:10-2:29',
              target_text: 'envKey',
              classification: 'out-of-scope',
              owner: 'authority-inventory-test',
              rationale:
                'The fixture proves that an exact dynamic environment access requires a durable rationale.',
              migration_phase: 'out-of-scope-environment',
              expiry_or_removal_condition:
                'Remove when this fixture no longer exercises exact dynamic environment waivers.',
            },
          ],
          helperKeys: [],
          boundaryKeys: [],
        }),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains secondary source coverage for run-root and helper inventory', () => {
    const root = repoRoot();
    for (const path of [
      'src/cli/index.ts',
      'src/cli/project-runtime-codex-homes.ts',
    ]) {
      const source = readFileSync(resolve(root, path), 'utf-8');
      assert.match(
        source,
        /OMX_RUNS_DIR/,
        `secondary text scan lost ${path} OMX_RUNS_DIR coverage`,
      );
    }
    for (const helperKey of AUTHORITY_TRANSITIVE_HELPER_KEYS) {
      const [path, symbol] = helperKey.split('::');
      const source = readFileSync(resolve(root, path!), 'utf-8');
      assert.ok(
        source.includes(symbol!),
        `secondary text scan lost helper ${helperKey}`,
      );
    }
  });
});

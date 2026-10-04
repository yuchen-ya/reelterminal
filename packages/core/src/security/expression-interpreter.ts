import { parse, type Expression, type Node, type Statement } from "acorn";

type Scope = Readonly<Record<string, unknown>>;
type Evaluator = (scope: Scope) => unknown;

const MAX_CODE_LENGTH = 8192;
const MAX_NODES = 1024;
const MAX_DEPTH = 64;

/** Interpret animation arithmetic and scope helpers without executing JavaScript. */
export function compileExpression(code: string): Evaluator {
  if (code.length > MAX_CODE_LENGTH) {
    throw new SyntaxError(`Expression exceeds ${MAX_CODE_LENGTH} characters`);
  }
  const program = parse(code, {
    ecmaVersion: 2020,
    allowReturnOutsideFunction: true,
  });
  let nodes = 0;
  const validate = (node: Node, depth = 0): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new SyntaxError("Expression is too complex");
    }
    const child = (value: Node) => validate(value, depth + 1);
    switch (node.type) {
      case "Identifier":
      case "EmptyStatement":
        return;
      case "Literal": {
        const literal = node as Extract<Expression, { type: "Literal" }>;
        if (literal.regex || literal.bigint) {
          throw new SyntaxError("Only numbers, strings, booleans and null are allowed");
        }
        return;
      }
      case "ExpressionStatement":
        child((node as Extract<Statement, { type: "ExpressionStatement" }>).expression);
        return;
      case "ReturnStatement": {
        const argument = (node as Extract<Statement, { type: "ReturnStatement" }>).argument;
        if (argument) child(argument);
        return;
      }
      case "VariableDeclaration": {
        const declaration = node as Extract<Statement, { type: "VariableDeclaration" }>;
        if (declaration.kind === "var") throw new SyntaxError("Use const or let for local values");
        for (const item of declaration.declarations) {
          if (item.id.type !== "Identifier" || !item.init) {
            throw new SyntaxError("Local values need a name and initializer");
          }
          child(item.init);
        }
        return;
      }
      case "UnaryExpression": {
        const unary = node as Extract<Expression, { type: "UnaryExpression" }>;
        if (!["+", "-", "!", "~", "typeof"].includes(unary.operator)) {
          throw new SyntaxError(`Unsupported operator: ${unary.operator}`);
        }
        child(unary.argument);
        return;
      }
      case "BinaryExpression": {
        const binary = node as Extract<Expression, { type: "BinaryExpression" }>;
        if (["in", "instanceof"].includes(binary.operator)) {
          throw new SyntaxError(`Unsupported operator: ${binary.operator}`);
        }
        child(binary.left);
        child(binary.right);
        return;
      }
      case "LogicalExpression": {
        const logical = node as Extract<Expression, { type: "LogicalExpression" }>;
        child(logical.left);
        child(logical.right);
        return;
      }
      case "ConditionalExpression": {
        const conditional = node as Extract<Expression, { type: "ConditionalExpression" }>;
        child(conditional.test);
        child(conditional.consequent);
        child(conditional.alternate);
        return;
      }
      case "MemberExpression": {
        const member = node as Extract<Expression, { type: "MemberExpression" }>;
        child(member.object);
        if (member.computed) child(member.property);
        return;
      }
      case "CallExpression": {
        const call = node as Extract<Expression, { type: "CallExpression" }>;
        child(call.callee);
        call.arguments.forEach(child);
        return;
      }
      default:
        throw new SyntaxError(`Unsupported expression syntax: ${node.type}`);
    }
  };
  program.body.forEach((node) => validate(node));

  return (scope) => {
    const values = new Map(Object.entries(scope));
    const evaluate = (node: Expression): unknown => {
      switch (node.type) {
        case "Literal":
          return node.value;
        case "Identifier":
          if (!values.has(node.name)) throw new ReferenceError(`${node.name} is not defined`);
          return values.get(node.name);
        case "UnaryExpression": {
          const value = evaluate(node.argument);
          switch (node.operator) {
            case "+": return Number(value);
            case "-": return -Number(value);
            case "!": return !value;
            case "~": return ~Number(value);
            case "typeof": return typeof value;
          }
          break;
        }
        case "BinaryExpression": {
          const left = evaluate(node.left as Expression);
          const right = evaluate(node.right);
          switch (node.operator) {
            case "+": return typeof left === "string" || typeof right === "string"
              ? String(left) + String(right) : Number(left) + Number(right);
            case "-": return Number(left) - Number(right);
            case "*": return Number(left) * Number(right);
            case "/": return Number(left) / Number(right);
            case "%": return Number(left) % Number(right);
            case "**": return Number(left) ** Number(right);
            case "<": return Number(left) < Number(right);
            case "<=": return Number(left) <= Number(right);
            case ">": return Number(left) > Number(right);
            case ">=": return Number(left) >= Number(right);
            case "==": return left == right;
            case "!=": return left != right;
            case "===": return left === right;
            case "!==": return left !== right;
            case "<<": return Number(left) << Number(right);
            case ">>": return Number(left) >> Number(right);
            case ">>>": return Number(left) >>> Number(right);
            case "|": return Number(left) | Number(right);
            case "&": return Number(left) & Number(right);
            case "^": return Number(left) ^ Number(right);
          }
          break;
        }
        case "LogicalExpression": {
          const left = evaluate(node.left);
          if (node.operator === "&&") return left && evaluate(node.right);
          if (node.operator === "||") return left || evaluate(node.right);
          return left ?? evaluate(node.right);
        }
        case "ConditionalExpression":
          return evaluate(node.test) ? evaluate(node.consequent) : evaluate(node.alternate);
        case "MemberExpression": {
          const object = evaluate(node.object as Expression);
          const property = node.computed
            ? String(evaluate(node.property as Expression))
            : (node.property as Extract<Expression, { type: "Identifier" }>).name;
          // Only trusted scope records are reachable; function/prototype internals are not.
          if (object == null || typeof object === "function" ||
              ["constructor", "prototype", "__proto__"].includes(property)) {
            throw new Error(`Property is not available: ${property}`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(Object(object), property);
          if (!descriptor) {
            throw new Error(`Property is not available: ${property}`);
          }
          return Object.hasOwn(descriptor, "value") ? descriptor.value : descriptor.get?.call(object);
        }
        case "CallExpression": {
          const fn = evaluate(node.callee as Expression);
          if (typeof fn !== "function") throw new Error("Expression helper is not callable");
          return fn(...node.arguments.map((argument) => evaluate(argument as Expression)));
        }
      }
      throw new Error(`Unsupported expression syntax: ${node.type}`);
    };

    if (program.body.length === 1 && program.body[0].type === "ExpressionStatement") {
      return evaluate(program.body[0].expression);
    }
    for (const statement of program.body) {
      if (statement.type === "ReturnStatement") {
        return statement.argument ? evaluate(statement.argument) : undefined;
      }
      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations) {
          const name = (declaration.id as Extract<Expression, { type: "Identifier" }>).name;
          if (values.has(name)) throw new Error(`Local value already exists: ${name}`);
          values.set(name, evaluate(declaration.init!));
        }
      } else if (statement.type === "ExpressionStatement") {
        evaluate(statement.expression);
      }
    }
    return undefined;
  };
}

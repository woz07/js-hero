let pyodidePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);

    if (existingScript) {
      if (window.loadPyodide) {
        resolve();
      } else {
        existingScript.addEventListener("load", resolve);
        existingScript.addEventListener("error", reject);
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = loadScript("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js")
      .then(() => window.loadPyodide());
  }

  return pyodidePromise;
}

export function protectPythonCode(code, limit = 10000, errorMessage = "Possible infinite loop detected") {
  const lines = code.split('\n');
  const result = [];
  let inSolutionFunc = false;
  let counterInjected = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    // Detect solution function definition
    if (trimmed.startsWith('def solution(')) {
      inSolutionFunc = true;
      counterInjected = false;
      result.push(line);
      continue;
    }

    // Inject counter variable after function definition
    if (inSolutionFunc && !counterInjected && trimmed && !trimmed.startsWith('#')) {
      result.push(`${indent}_loop_counter = 0`);
      counterInjected = true;
    }

    // Detect and protect loops
    if (inSolutionFunc && (trimmed.startsWith('while ') || trimmed.startsWith('for '))) {
      result.push(line); // Add the loop line itself
      
      // Add counter check as FIRST statement in loop body (with extra indentation)
      const bodyIndent = indent + '    ';
      result.push(`${bodyIndent}_loop_counter += 1`);
      result.push(`${bodyIndent}if _loop_counter > ${limit}:`);
      result.push(`${bodyIndent}    raise RuntimeError('${errorMessage}')`);
      
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

export async function compilePythonSolution(code) {
  const pyodide = await getPyodide();

  try {
    pyodide.globals.delete("solution");
  } catch (e) {
    // solution does not exist yet, which is fine
  }

  const protectedCode = protectPythonCode(code);
  pyodide.runPython(protectedCode);

  let solution;

  try {
    solution = pyodide.globals.get("solution");
  } catch (e) {
    throw new Error("Python solution(player) function not defined");
  }

  if (!solution) {
    throw new Error("Python solution(player) function not defined");
  }

  return function pythonSolution(player) {
    try {
      return solution(player);
    } catch (e) {
      // Extract just the error message from Python RuntimeError
      // Python traceback format: "RuntimeError: message"
      const errorMessage = e.toString();
      const match = errorMessage.match(/RuntimeError: (.+)/);
      if (match) {
        throw new Error(match[1]);
      }
      throw e;
    }
  };
}
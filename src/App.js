import { renderSequence } from './render-sequence';
import { useState, useEffect, useRef, useCallback } from 'react';
import levels_config from './levels';
import { getMoves } from './engine';
import Editor from "@monaco-editor/react";
import * as esprima from "esprima";
import debounce from 'lodash/debounce';
import loopProtect from './loop-protect';
import SimpleModal from './simple-modal';
import { compilePythonSolution } from './python-runner';

const mtheme = {
  headerColorBg: "bg-regal-blue",
  headerColorBorder: "border-regal-blue",
  levelBg: "bg-indigo-50",
  good: "bg-green-500",
  bad: "bg-red-500",
  goodHover: "hover:bg-green-700",
  badHover: "hover:bg-red-700"
};

function setupMonaco(monaco) {
  function ShowAutocompletion(obj) {
    function getType(thing, isMember) {
      isMember = isMember === undefined ? false : isMember;

      switch ((typeof thing).toLowerCase()) {
        case "object":
          return monaco.languages.CompletionItemKind.Class;
        case "function":
          return isMember
            ? monaco.languages.CompletionItemKind.Method
            : monaco.languages.CompletionItemKind.Function;
        default:
          return isMember
            ? monaco.languages.CompletionItemKind.Property
            : monaco.languages.CompletionItemKind.Variable;
      }
    }

    function provideCompletionItems(model, position) {
      const last_chars = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 0,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      });

      const words = last_chars.replace("\t", "").split(" ");
      const active_typing = words[words.length - 1];
      const is_member = active_typing.charAt(active_typing.length - 1) === ".";

      const result = [];
      let last_token = obj;
      let prefix = '';

      if (is_member) {
        const parents = active_typing.substring(0, active_typing.length - 1).split(".");
        last_token = obj[parents[0]];
        prefix = parents[0];

        for (let i = 1; i < parents.length; i++) {
          if (last_token && last_token.hasOwnProperty(parents[i])) {
            prefix += '.' + parents[i];
            last_token = last_token[parents[i]];
          } else {
            return { suggestions: result };
          }
        }

        prefix += '.';
      }

      for (const prop in last_token) {
        if (last_token.hasOwnProperty(prop) && !prop.startsWith("__")) {
          let details = '';

          try {
            details = last_token[prop].__proto__.constructor.name;
          } catch (e) {
            details = typeof last_token[prop];
          }

          const to_push = {
            label: prefix + prop,
            kind: getType(last_token[prop], is_member),
            detail: details,
            insertText: prop
          };

          if (to_push.detail.toLowerCase() === 'function') {
            to_push.insertText += "()";
            to_push.documentation = last_token[prop].toString().split("{")[0];
          }

          result.push(to_push);
        }
      }

      return { suggestions: result };
    }

    monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['.', '('],
      provideCompletionItems
    });

    monaco.languages.registerCompletionItemProvider('python', {
      triggerCharacters: ['.', '('],
      provideCompletionItems
    });
  }

  ShowAutocompletion({
    player: {
      turnLeft: function turnLeft() { },
      turnRight: function turnRight() { },
      step: function step() { },
      attack: function attack() { },
      isNextToTarget: function isNextToTarget() { },
      check: function check(action) { },
      checkMap: function checkMap(x, y) { },
      x: 0,
      y: 0,
      direction: "NORTH",
      target_x: 0,
      target_y: 0
    }
  });
}

const initialJavascriptCode = `
/**
 * player supports the following API
 *      - Functions
 *          - turnLeft()
 *          - turnRight()
 *          - step()
 *          - attack()
 *          - isNextToTarget(): tells you if you are in a winning position
 *          - check(action): Tells you what is at the action you want to check
 *              Argument action: Has to be 'LEFT', 'RIGHT' or 'STEP'
 *              Returns: "MONSTER", "TARGET", "ROCK", "NOTHING" or "ERROR"
 *          - checkMap(x, y): check the thing that is at coordinates x and y
 *              Returns: "MONSTER", "PLAYER", "TARGET", "ROCK", "NOTHING" or "ERROR"
 *      - Properties
 *          - x: number
 *          - y: number
 *          - direction: "NORTH" or "SOUTH" or "EAST" or "WEST"
 *          - target_x
 *          - target_y
 *
 * @param {*} player
 */
function solution(player) {
    // Add code here
}
`;

const initialPythonCode = `"""
player supports the following API

Functions:
    turnLeft()
    turnRight()
    step()
    attack()
    isNextToTarget()
    check(action)
        action must be "LEFT", "RIGHT" or "STEP"
        returns "MONSTER", "TARGET", "ROCK", "NOTHING" or "ERROR"
    checkMap(x, y)
        returns "MONSTER", "PLAYER", "TARGET", "ROCK", "NOTHING" or "ERROR"

Properties:
    x
    y
    direction: "NORTH", "SOUTH", "EAST" or "WEST"
    target_x
    target_y
"""

def solution(player):
    # Add code here
    pass
`;

const storage = {
  getCode: (language) => {
    const key = language === "python" ? "jsHeroPythonCode" : "jsHeroJavascriptCode";
    const fallback = language === "python" ? initialPythonCode : initialJavascriptCode;

    const savedCode = window.localStorage.getItem(key);

    if (!savedCode) {
      window.localStorage.setItem(key, fallback);
      return fallback;
    }

    return savedCode;
  },

  setCode: (language, code) => {
    const key = language === "python" ? "jsHeroPythonCode" : "jsHeroJavascriptCode";
    window.localStorage.setItem(key, code);
  },

  getCurrentLevel: () => {
    const currentLevel = window.localStorage.getItem('currentLevel');

    if (!currentLevel) {
      window.localStorage.setItem('currentLevel', 1);
      return 1;
    }

    return currentLevel;
  },

  setCurrentLevel: (level) => {
    window.localStorage.setItem('currentLevel', level);
  }
};

function validator(code, severity) {
  const markers = [];

  try {
    const strictCode = "'use strict';" + code;
    const syntax = esprima.parse(strictCode, {
      tolerant: true,
      loc: true,
      range: true
    });

    if (syntax.errors.length > 0) {
      for (let i = 0; i < syntax.errors.length; ++i) {
        const e = syntax.errors[i];

        markers.push({
          severity,
          startLineNumber: e.lineNumber,
          startColumn: e.column,
          endLineNumber: e.lineNumber,
          endColumn: e.column,
          message: e.description
        });
      }
    }
  } catch (e) {
    markers.push({
      severity,
      startLineNumber: e.lineNumber || 1,
      startColumn: e.column || 1,
      endLineNumber: e.lineNumber || 1,
      endColumn: e.column || 1,
      message: e.toString()
    });
  }

  return markers;
}

function LanguageSelection({ languageOptions, onLanguageSelect }) {
  const classNames = {
    selected: `px-2 border-r ${mtheme.headerColorBorder} mtk8`,
    unselected: `px-2 border-b-2 border-l border-r ${mtheme.headerColorBorder} mtk1`
  };

  return (
    <div className="text-sm text-white float-left monaco-editor-background">
      {languageOptions.map(option => (
        <button
          key={option.name}
          onClick={() => onLanguageSelect(option.name)}
          className={option.selected ? classNames.selected : classNames.unselected}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function JsHeroEditor({
  onCodeUpdate,
  languageOptions,
  selectedLanguage,
  onLanguageSelect
}) {
  const [codeByLanguage, setCodeByLanguage] = useState({
    javascript: storage.getCode("javascript"),
    python: storage.getCode("python")
  });

  const monacoRef = useRef(null);
  const editorRef = useRef(null);

  const delayedUpdate = useCallback(
    debounce((code, language, update) => handleValidation(code, language, update), 750),
    []
  );

  const code = codeByLanguage[selectedLanguage];

  const handleEditorWillMount = (monaco) => {
    setupMonaco(monaco);
  };

  const handleEditorDidMount = (editor, monaco) => {
    editor._domElement.id = "code-editor";
    editorRef.current = editor;
    monacoRef.current = monaco;
    handleEditorChange(code);
  };

  const handleValidation = (value, language, update) => {
    if (language === "python") {
      monacoRef.current.editor.setModelMarkers(
        editorRef.current.getModel(),
        "code-editor",
        []
      );
      update(value);
      return;
    }

    const markers = validator(value, monacoRef.current.MarkerSeverity.Error);

    if (markers.length === 0) {
      update(value);
    } else {
      update(initialJavascriptCode);
    }

    monacoRef.current.editor.setModelMarkers(
      editorRef.current.getModel(),
      "code-editor",
      markers
    );
  };

  const handleEditorChange = (value = "") => {
    setCodeByLanguage(prev => ({
      ...prev,
      [selectedLanguage]: value
    }));

    storage.setCode(selectedLanguage, value);
    delayedUpdate(value, selectedLanguage, onCodeUpdate);
  };

  useEffect(() => {
    if (editorRef.current) {
      handleEditorChange(code);
    }
  }, [selectedLanguage]);

  return (
    <div
      style={{
        float: "left",
        width: "50%",
        overflow: "scroll",
        flex: "1 1 auto",
        overflowY: "auto",
        minHeight: "100px"
      }}
      className={`${mtheme.headerColorBg}`}
    >
      <LanguageSelection
        languageOptions={languageOptions}
        onLanguageSelect={onLanguageSelect}
      />

      <Editor
        height="100vh"
        language={selectedLanguage}
        value={code}
        onChange={handleEditorChange}
        theme="vs-dark"
        onMount={handleEditorDidMount}
        beforeMount={handleEditorWillMount}
      />
    </div>
  );
}

function LevelToggle({ name, success, onToggle }) {
  const classColor = success
    ? `${mtheme.good} ${mtheme.goodHover} text-white`
    : `${mtheme.bad} ${mtheme.badHover} text-white`;

  return (
    <button
      onClick={onToggle}
      className={classColor + " font-bold my-1 mx-2 py-1 px-2 w-28 rounded inline-flex justify-center"}
    >
      <span className="px-1">Level {name}</span>
      {
        success
          ? <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="px-1 feather feather-smile"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
          : <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="px-1 feather feather-frown"><circle cx="12" cy="12" r="10"></circle><path d="M16 16s-1.5-2-4-2-4 2-4 2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
      }
    </button>
  );
}

function LevelDisplay({ message, config, moves }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    renderSequence(canvasRef.current, config, JSON.parse(JSON.stringify(moves)));
  }, [canvasRef.current, config, moves]);

  return (
    <div style={{ width: "100%" }}>
      <StatusInfo message={message} />
      <canvas
        onClick={() => {
          renderSequence(canvasRef.current, config, JSON.parse(JSON.stringify(moves)));
        }}
        ref={canvasRef}
        id="levelDisplayCanvas"
        style={{
          display: "inline-block",
          alignContent: "flex-end"
        }}
      />
    </div>
  );
}

function Levels({ levelsState, updateLevelState }) {
  const expandedLevelState = levelsState.find(levelState => levelState.isExpanded);

  return (
    <div
      id="results"
      style={{
        height: "100vh",
        float: "left",
        width: "50%",
        overflow: "scroll"
      }}
      className={`${mtheme.levelBg}`}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap"
        }}
      >
        {levelsState.map((levelState, i) => (
          <LevelToggle
            key={i + 1}
            name={i + 1}
            success={levelState.success}
            onToggle={() => updateLevelState(i)}
          />
        ))}
      </div>

      {!!expandedLevelState ? <LevelDisplay key="canvas" {...expandedLevelState} /> : null}
    </div>
  );
}

function StatusInfo({ message }) {
  if (!message) {
    return null;
  }

  return (
    <div className="flex items-center bg-red-500 text-white text-sm font-bold px-4 py-3 my-2" role="alert">
      <svg className="w-4 h-4 mr-2 feather feather-alert-circle" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <p className="px-2">{message}</p>
    </div>
  );
}

function useSolutionFunc() {
  const solutionHarness = (answer) => {
    return (level) => {
      let result;

      try {
        result = getMoves(level, answer);
      } catch (e) {
        result = {
          moves: [[{ action: 'die' }]],
          message: e.message
        };
      }

      return result;
    };
  };

  const [solutionFunc, _setSolutionFunc] = useState({ solution: null });
  const setSolutionFunc = (func) => _setSolutionFunc({ solution: solutionHarness(func) });

  return [solutionFunc.solution, setSolutionFunc];
}

function Header() {
  const [isModalOpen, setModalOpen] = useState(false);
  const closeModal = () => setModalOpen(false);

  return (
    <>
      <SimpleModal
        isModalOpen={isModalOpen}
        closeModal={closeModal}
        title="What is JS Hero?"
        closeButton="Gotcha!"
      >
        <p className="py-2">
          JS Hero is a coding game to help people practice coding concepts. Navigate the character to the target to win each level.
        </p>
        <p>
          Every level uses the same solution which means players have to build together an algorithm to eventually succeed.
        </p>
      </SimpleModal>

      <header className={mtheme.headerColorBg}>
        <nav className="w-full text-white p-2 grid grid-cols-3 justify-items-center">
          <a href="/" className="col-start-2">
            <span className="font-semibold text-xl tracking-tight">JS Hero</span>
          </a>

          <button className="ml-auto" onClick={() => setModalOpen(true)}>
            <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="feather feather-help-circle">
              <circle cx={12} cy={12} r={10} />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1={12} y1={17} x2="12.01" y2={17} />
            </svg>
          </button>
        </nav>
      </header>
    </>
  );
}

function App() {
  const [failureMessage, setFailureMessage] = useState(null);
  const [solution, setSolutionFunc] = useSolutionFunc();
  const [levelsState, setLevelsState] = useState([]);
  const [selectedLanguage, setSelectedLanguage] = useState("javascript");

  const languageOptions = [
    {
      selected: selectedLanguage === "javascript",
      name: "javascript"
    },
    {
      selected: selectedLanguage === "python",
      name: "python"
    }
  ];

  const updateLevelState = (levelClicked) => {
    if (!solution) {
      return;
    }

    let currentLevel = Number(storage.getCurrentLevel());
    let allSuccess = true;
    const newLevelsState = [];
    const toggle_i = typeof levelClicked === "number" ? levelClicked : -1;

    for (let i = 0; i < levels_config.length && i <= currentLevel; i++) {
      const { moves, message } =
        toggle_i < 0 || toggle_i === i
          ? solution(levels_config[i].design)
          : levelsState[i];

      const lastAction = moves[moves.length - 1][0];
      const levelPassed = lastAction.action !== 'die';

      const newLevelState = {
        id: "level-" + (i + 1),
        isExpanded: levelsState[i] ? levelsState[i].isExpanded : false,
        message: failureMessage || message,
        success: levelPassed,
        config: levels_config[i],
        moves
      };

      if (levelPassed && allSuccess) {
        currentLevel = Math.max(i + 1, currentLevel);
      } else {
        allSuccess = false;
      }

      if (toggle_i > -1) {
        newLevelState.isExpanded = toggle_i === i ? !newLevelState.isExpanded : false;
      }

      newLevelsState.push(newLevelState);
    }

    storage.setCurrentLevel(currentLevel);
    setLevelsState(newLevelsState);
  };

  useEffect(() => {
    if (solution) {
      updateLevelState(-1);
    }
  }, [solution]);

  async function updateSolution(value) {
    try {
      setFailureMessage(null);

      if (selectedLanguage === "python") {
        const fn = await compilePythonSolution(value);
        setSolutionFunc(fn);
        return;
      }

      const code =
        loopProtect(value, 10000, "Possible infinite loop detected") +
        "\nwindow.solution = solution";

      delete window.solution;
      eval(code);

      if (!window.solution) {
        throw new Error("Solution function not defined");
      }

      setSolutionFunc(window.solution);
    } catch (e) {
      setFailureMessage(e.message);
    }
  }

  return (
    <div className="App">
      <Header />

      <div>
        <Levels
          levelsState={levelsState}
          updateLevelState={updateLevelState}
        />

        <JsHeroEditor
          selectedLanguage={selectedLanguage}
          languageOptions={languageOptions}
          onLanguageSelect={setSelectedLanguage}
          onCodeUpdate={updateSolution}
        />
      </div>
    </div>
  );
}

export default App;

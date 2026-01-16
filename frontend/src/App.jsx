import { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';
import './index.css';

const SOCKET_URL = 'http://localhost:3005';

function App() {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [gameState, setGameState] = useState({
    status: 'CONNECTING',
    multiplier: 1.00,
    startTime: null,
    crashPoint: null
  });
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connected to backend');
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Disconnected from backend');
      setIsConnected(false);
    });

    newSocket.on('initial_state', (data) => {
      console.log('Initial State:', data);
      if (data.gameState) setGameState(data.gameState);
      if (data.history) setHistory(data.history);
    });

    newSocket.on('game_tick', (data) => {
      setGameState(data);
    });

    newSocket.on('game_starting', (data) => {
      setGameState(data);
    });

    newSocket.on('game_crash', (data) => {
      setGameState(data);
    });

    newSocket.on('history_update', (data) => {
      setHistory(data);
    });

    return () => newSocket.close();
  }, []);

  return (
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Stake Crash Clone</h1>
        <span style={{ color: isConnected ? '#00e701' : '#ff4d4d', fontSize: '0.8em' }}>
          {isConnected ? '● Connected' : '○ Disconnected'}
        </span>
      </header>

      <HistoryBar history={history} />

      <GameDisplay gameState={gameState} />

      <StatsPanel history={history} />

    </div>
  );
}

function HistoryBar({ history }) {
  return (
    <div className="history-bar">
      {history.map((item, index) => (
        <div
          key={index}
          className={`history-item ${item.crashPoint >= 2 ? 'green' : 'red'}`}
        >
          {Number(item.crashPoint).toFixed(2)}x
        </div>
      ))}
      <div className="history-item" style={{ opacity: 0.5 }}>...</div>
    </div>
  );
}

function GameDisplay({ gameState }) {
  const { status, multiplier, crashPoint } = gameState;

  // Visual tweaks based on status
  let displayValue = '1.00x';
  if (status === 'IN_PROGRESS') displayValue = `${Number(multiplier).toFixed(2)}x`;
  if (status === 'CRASHED') displayValue = `Crashed @ ${Number(crashPoint).toFixed(2)}x`;
  if (status === 'STARTING') displayValue = 'Preparing...';

  // Calculate curve or simple animation class
  const isCrashed = status === 'CRASHED';

  return (
    <div className="game-area">
      <div className={`multiplier-display ${isCrashed ? 'crashed' : 'live'}`}>
        {status === 'STARTING' ?
          <div style={{ fontSize: '0.4em' }}>Game Starts Soon</div> :
          (isCrashed ?
            <>
              <div style={{ fontSize: '0.3em', color: '#b1bad3' }}>CRASHED</div>
              {Number(crashPoint).toFixed(2)}x
            </>
            :
            `${Number(multiplier).toFixed(2)}x`
          )
        }
      </div>

      {status === 'IN_PROGRESS' && (
        <div className="status-text">Creating new blocks...</div>
      )}
    </div>
  );
}

function StatsPanel({ history }) {
  // Simple stats
  const last100 = history.slice(0, 100);
  const count = last100.length || 1;
  const greenCount = last100.filter(h => h.crashPoint >= 2).length;
  const redCount = last100.length - greenCount;

  return (
    <div className="stats-panel">
      <div className="stat-card">
        <div className="stat-title">History Length</div>
        <div className="stat-value">{history.length}</div>
      </div>
      <div className="stat-card">
        <div className="stat-title">Recent Greens</div>
        <div className="stat-value" style={{ color: '#00e701' }}>{greenCount}</div>
      </div>
      <div className="stat-card">
        <div className="stat-title">Recent Reds</div>
        <div className="stat-value" style={{ color: '#ff4d4d' }}>{redCount}</div>
      </div>
    </div>
  )
}

export default App;

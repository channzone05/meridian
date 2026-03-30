import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';
import {FPS} from '../utils/timing';
import {GlowingText} from '../components/GlowingText';
import {HexNode} from '../components/HexNode';
import {FlowArrow} from '../components/FlowArrow';

/* ------------------------------------------------------------------ */
/*  Agent node definitions                                             */
/* ------------------------------------------------------------------ */

interface AgentNode {
  x: number;
  y: number;
  label: string;
  color: string;
  delay: number;
}

const CENTER = {x: 960, y: 400};

const AGENT_NODES: AgentNode[] = [
  {x: 400, y: 250, label: 'Agent 1', color: COLORS.green, delay: 70},
  {x: 650, y: 180, label: 'Agent 2', color: COLORS.blue, delay: 85},
  {x: 960, y: 150, label: 'Agent 3', color: COLORS.amber, delay: 100},
  {x: 1270, y: 180, label: 'Agent 4', color: COLORS.green, delay: 115},
  {x: 1520, y: 250, label: 'Agent 5', color: COLORS.blue, delay: 130},
];

const HEX_SIZE_CENTER = 120;
const HEX_SIZE_AGENT = 60;

/* ------------------------------------------------------------------ */
/*  Data packet (glowing dot traveling from agent to center)           */
/* ------------------------------------------------------------------ */

const DataPacket: React.FC<{
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  frame: number;
  startFrame: number;
  travelDuration: number;
  color: string;
}> = ({fromX, fromY, toX, toY, frame, startFrame, travelDuration, color}) => {
  if (frame < startFrame) return null;

  const elapsed = frame - startFrame;
  // Repeat the travel every (travelDuration + 20) frames
  const cycleLength = travelDuration + 20;
  const cycleFrame = elapsed % cycleLength;
  const t = interpolate(cycleFrame, [0, travelDuration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Only show during travel portion of cycle
  if (cycleFrame > travelDuration) return null;

  const cx = fromX + (toX - fromX) * t;
  const cy = fromY + (toY - fromY) * t;

  const pulse = Math.sin(frame * 0.15) * 0.3 + 0.7;

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - 4,
        top: cy - 4,
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: `0 0 8px ${color}, 0 0 16px ${color}88`,
        opacity: pulse,
        pointerEvents: 'none',
      }}
    />
  );
};

/* ------------------------------------------------------------------ */
/*  Main scene                                                         */
/* ------------------------------------------------------------------ */

export const HiveMindClosing: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  /* --- Title --- */
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /* --- Center hex entrance --- */
  const centerProgress = spring({
    frame: Math.max(0, frame - 40),
    fps,
    config: SPRING_CONFIGS.bouncy,
  });
  const centerScale = interpolate(centerProgress, [0, 1], [0, 1]);
  const centerOpacity = interpolate(centerProgress, [0, 1], [0, 1]);

  /* --- Labels entrance (frames 200-350) --- */
  const label1Progress = spring({
    frame: Math.max(0, frame - 220),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const label1Opacity = interpolate(label1Progress, [0, 1], [0, 1]);

  const label2Progress = spring({
    frame: Math.max(0, frame - 260),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const label2Opacity = interpolate(label2Progress, [0, 1], [0, 1]);

  const label3Progress = spring({
    frame: Math.max(0, frame - 300),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const label3Opacity = interpolate(label3Progress, [0, 1], [0, 1]);

  /* --- Closing sequence (frames 400+) --- */
  const networkFadeOpacity = interpolate(frame, [400, 430], [1, 0.3], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const meridianProgress = spring({
    frame: Math.max(0, frame - 420),
    fps,
    config: SPRING_CONFIGS.bouncy,
  });
  const meridianScale = interpolate(meridianProgress, [0, 1], [0.8, 1]);
  const meridianOpacity = interpolate(meridianProgress, [0, 1], [0, 1]);

  /* Tagline words */
  const TAGLINE_WORDS = [
    {text: 'Autonomous.', color: COLORS.green, delay: 450},
    {text: 'Adaptive.', color: COLORS.blue, delay: 480},
    {text: 'Evolving.', color: COLORS.purple, delay: 510},
  ];

  /* Final glow pulse */
  const finalPulse = frame > 540 ? Math.sin((frame - 540) * 0.04) * 0.15 + 1.0 : 1.0;

  return (
    <AbsoluteFill>
      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 40,
          left: 0,
          width: 1920,
          textAlign: 'center',
          opacity: titleOpacity,
        }}
      >
        <GlowingText text="HIVE MIND" fontSize={40} />
      </div>

      {/* ============ NETWORK VISUALIZATION ============ */}
      <div style={{opacity: networkFadeOpacity}}>
        {/* Connection arrows from each agent to center */}
        {AGENT_NODES.map((agent, i) => (
          <FlowArrow
            key={`arrow-${i}`}
            fromX={agent.x}
            fromY={agent.y}
            toX={CENTER.x}
            toY={CENTER.y}
            color={agent.color}
            delay={130 + i * 20}
            duration={40}
          />
        ))}

        {/* Data packets traveling along connections */}
        {AGENT_NODES.map((agent, i) => (
          <DataPacket
            key={`packet-${i}`}
            fromX={agent.x}
            fromY={agent.y}
            toX={CENTER.x}
            toY={CENTER.y}
            frame={frame}
            startFrame={180 + i * 15}
            travelDuration={45}
            color={agent.color}
          />
        ))}

        {/* Center hex: Hive Mind */}
        <div
          style={{
            position: 'absolute',
            left: CENTER.x - HEX_SIZE_CENTER,
            top: CENTER.y - HEX_SIZE_CENTER,
            transform: `scale(${centerScale})`,
            opacity: centerOpacity,
          }}
        >
          <HexNode
            label="Hive Mind"
            color={COLORS.purple}
            size={HEX_SIZE_CENTER}
            delay={0}
          />
        </div>

        {/* Agent hex nodes */}
        {AGENT_NODES.map((agent, i) => {
          const agentProgress = spring({
            frame: Math.max(0, frame - agent.delay),
            fps,
            config: SPRING_CONFIGS.bouncy,
          });
          const agentScale = interpolate(agentProgress, [0, 1], [0, 1]);
          const agentOpacity = interpolate(agentProgress, [0, 1], [0, 1]);

          return (
            <div
              key={`agent-${i}`}
              style={{
                position: 'absolute',
                left: agent.x - HEX_SIZE_AGENT,
                top: agent.y - HEX_SIZE_AGENT,
                transform: `scale(${agentScale})`,
                opacity: agentOpacity,
              }}
            >
              <HexNode
                label={agent.label}
                color={agent.color}
                size={HEX_SIZE_AGENT}
                delay={0}
              />
            </div>
          );
        })}

        {/* Info labels near center */}
        <div
          style={{
            position: 'absolute',
            left: CENTER.x - 140,
            top: CENTER.y + HEX_SIZE_CENTER + 50,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            width: 280,
          }}
        >
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: 20,
              color: COLORS.white,
              opacity: label1Opacity,
            }}
          >
            3 agents deployed
          </div>
          <div
            style={{
              fontFamily: FONTS.body,
              fontSize: 20,
              fontWeight: 600,
              color: COLORS.green,
              opacity: label2Opacity,
              textShadow: GLOW.text(COLORS.green, 0.3),
            }}
          >
            67% win rate
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: FONTS.body,
              fontSize: 18,
              color: COLORS.gray,
              opacity: label3Opacity,
            }}
          >
            <span style={{fontSize: 16}}>&#x1F512;</span>
            <span>No private keys shared</span>
          </div>
        </div>
      </div>

      {/* ============ CLOSING SEQUENCE ============ */}
      {frame >= 400 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1920,
            height: 1080,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          {/* MERIDIAN title */}
          <div
            style={{
              opacity: meridianOpacity,
              transform: `scale(${meridianScale * finalPulse})`,
              fontFamily: FONTS.heading,
              fontSize: 64,
              fontWeight: 800,
              color: COLORS.white,
              textShadow: GLOW.purple(0.7),
              letterSpacing: 6,
              marginBottom: 32,
            }}
          >
            MERIDIAN
          </div>

          {/* Tagline words */}
          <div
            style={{
              display: 'flex',
              gap: 40,
              alignItems: 'center',
            }}
          >
            {TAGLINE_WORDS.map((word, i) => {
              const wordProgress = spring({
                frame: Math.max(0, frame - word.delay),
                fps,
                config: SPRING_CONFIGS.bouncy,
              });
              const wordScale = interpolate(wordProgress, [0, 1], [0.7, 1]);
              const wordOpacity = interpolate(wordProgress, [0, 1], [0, 1]);

              return (
                <div
                  key={i}
                  style={{
                    fontFamily: FONTS.heading,
                    fontSize: 36,
                    fontWeight: 700,
                    color: word.color,
                    opacity: wordOpacity,
                    transform: `scale(${wordScale * finalPulse})`,
                    textShadow: GLOW.text(word.color, 0.5),
                  }}
                >
                  {word.text}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

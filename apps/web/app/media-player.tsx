'use client';

import type { FC } from 'react';
import { MediaPlayer } from '@vidstack/react';

export type MediaPlayerClientProps = {
  className?: string;
  src: string;
  title?: string;
  playsInline?: boolean;
};

export default function MediaPlayerClient(props: MediaPlayerClientProps) {
  const Player = MediaPlayer as unknown as FC<MediaPlayerClientProps>;
  return <Player {...props} />;
}

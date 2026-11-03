import { Fragment, useState, type ReactNode } from 'react';
import type { ChatMention } from '../../shared/ipc';
import {
  parseExcerpt,
  parseMessage,
  type Block,
  type Inline,
  type ListBlock,
} from '../chat/format';
import { useT } from '../i18n';

/** Hidden until clicked, as a spoiler in Discord; clicked again, it stays shown. */
function Spoiler({ children, still }: { children: ReactNode; still?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  if (still) return <span className="chat-spoiler">{children}</span>;
  if (shown) return <span className="chat-spoiler shown">{children}</span>;
  return (
    <span
      className="chat-spoiler"
      role="button"
      tabIndex={0}
      aria-label={t('chat.spoiler')}
      title={t('chat.spoiler')}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setShown(true);
        }
      }}
    >
      {children}
    </span>
  );
}

interface InlineOptions {
  /** Your account, whose mentions stand out. */
  me?: string | null;
  /** In a reply's quote, which is itself a button: no links, spoilers stay shut. */
  still?: boolean;
}

function renderInline(nodes: Inline[], options: InlineOptions): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'bold':
        return <strong key={index}>{renderInline(node.children, options)}</strong>;
      case 'italic':
        return <em key={index}>{renderInline(node.children, options)}</em>;
      case 'underline':
        return <u key={index}>{renderInline(node.children, options)}</u>;
      case 'strike':
        return <s key={index}>{renderInline(node.children, options)}</s>;
      case 'spoiler':
        return (
          <Spoiler key={index} still={options.still}>
            {renderInline(node.children, options)}
          </Spoiler>
        );
      case 'code':
        return (
          <code key={index} className="chat-code">
            {node.text}
          </code>
        );
      case 'mention':
        return (
          <span
            key={index}
            className={`chat-mention${node.mention.id === options.me ? ' me' : ''}`}
          >
            {node.text}
          </span>
        );
      case 'link':
        if (options.still)
          return <Fragment key={index}>{renderInline(node.children, options)}</Fragment>;
        // Opened in the browser by the main window's open handler; the
        // address is in the title, for a masked link whose words differ.
        return (
          <a
            key={index}
            className="chat-link"
            href={node.href}
            title={node.href}
            target="_blank"
            rel="noreferrer"
          >
            {renderInline(node.children, options)}
          </a>
        );
    }
  });
}

function List({ list, options }: { list: ListBlock; options: InlineOptions }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {renderInline(item.children, options)}
      {item.lists.map((sub, subIndex) => (
        <List key={subIndex} list={sub} options={options} />
      ))}
    </li>
  ));
  return list.ordered ? (
    <ol className="chat-list" start={list.start}>
      {items}
    </ol>
  ) : (
    <ul className="chat-list">{items}</ul>
  );
}

function renderBlocks(blocks: Block[], options: InlineOptions, tail: ReactNode): ReactNode {
  return blocks.map((block, index) => {
    // The edited mark follows the last words, on their line when it can.
    const end = index === blocks.length - 1 ? tail : null;
    switch (block.kind) {
      case 'paragraph':
        return (
          <div key={index} className="chat-paragraph">
            {renderInline(block.children, options)}
            {end}
          </div>
        );
      case 'heading': {
        const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1]!;
        return (
          <Tag key={index} className={`chat-heading level-${block.level}`}>
            {renderInline(block.children, options)}
            {end}
          </Tag>
        );
      }
      case 'subtext':
        return (
          <div key={index} className="chat-subtext">
            {renderInline(block.children, options)}
            {end}
          </div>
        );
      case 'quote':
        return (
          <blockquote key={index} className="chat-blockquote">
            {renderBlocks(block.blocks, options, end)}
          </blockquote>
        );
      case 'codeBlock':
        return (
          <Fragment key={index}>
            <pre className="chat-codeblock" data-language={block.language}>
              <code>{block.text}</code>
            </pre>
            {end}
          </Fragment>
        );
      case 'list':
        return (
          <Fragment key={index}>
            <List list={block} options={options} />
            {end}
          </Fragment>
        );
    }
  });
}

/**
 * A message's text, formatted as Discord formats it (see chat/format.ts),
 * with its mentions and links; `tail`, the edited mark, after the last words.
 */
export default function MessageText({
  body,
  mentions,
  me,
  tail,
}: {
  body: string;
  mentions?: ChatMention[];
  me?: string | null;
  tail?: ReactNode;
}) {
  const blocks = parseMessage(body, mentions);
  return (
    <div className="chat-body">
      {blocks.length > 0 ? renderBlocks(blocks, { me }, tail ?? null) : tail}
    </div>
  );
}

/** A reply's excerpt of the message it answers, formatted, on one line. */
export function ExcerptText({ body }: { body: string }) {
  return <>{renderInline(parseExcerpt(body), { still: true })}</>;
}

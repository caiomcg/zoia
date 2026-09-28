import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Inline } from '../markdown';

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'bold':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'link':
        // Opened in the browser by the main window's open handler.
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

/** Release notes, rendered from parseMarkdown's tree; see markdown.ts. */
export default function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === 'heading') return <h5 key={index}>{renderInline(block.children)}</h5>;
        if (block.kind === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInline(block.children)}</p>;
      })}
    </div>
  );
}

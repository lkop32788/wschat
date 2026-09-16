interface Props {
  typingAgentIds: string[];
  contactIsTyping: boolean;
}

export default function TypingIndicator({ typingAgentIds, contactIsTyping }: Props) {
  const show = typingAgentIds.length > 0 || contactIsTyping;
  if (!show) return null;

  return (
    <div className="px-4 py-1 text-xs text-gray-400 italic">
      {contactIsTyping
        ? 'Pelanggan sedang mengetik...'
        : `${typingAgentIds.length} agen sedang mengetik...`}
    </div>
  );
}

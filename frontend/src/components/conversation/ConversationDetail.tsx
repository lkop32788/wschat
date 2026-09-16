import ConversationHeader from './ConversationHeader';
import MessageList from './MessageList';
import MessageInput from './MessageInput';

export default function ConversationDetail() {
  return (
    <div className="flex flex-col h-full">
      <ConversationHeader />
      <MessageList />
      <MessageInput />
    </div>
  );
}

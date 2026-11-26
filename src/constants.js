const ROLES = {
  ADMIN: 'ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  CALLING_STAFF: 'CALLING_STAFF',
};

const CALL_OUTCOMES = [
  'Successfully Contacted',
  'No Answer',
  'Not Reachable',
  'Switched Off',
  'Busy',
  'Call Disconnected',
  'Invalid / Wrong Number',
  'Callback Requested',
  'Parent Contacted',
  'Student Contacted',
  'Information Communicated',
  'Not Interested',
  'Other',
];

const COMMUNICATION_STATUSES = [
  'Not Assigned',
  'Pending First Call',
  'Attempt 1 Completed',
  'Pending Second Call',
  'Attempt 2 Completed',
  'Pending Third Call',
  'Attempt 3 Completed',
  'Email Notification Sent',
  'Successfully Contacted',
  'Callback Scheduled',
  'Number Correction Required',
  'Follow-up Completed',
];

const SUCCESS_OUTCOMES = new Set([
  'Successfully Contacted',
  'Parent Contacted',
  'Student Contacted',
  'Information Communicated',
]);

const UNREACHABLE_OUTCOMES = new Set([
  'No Answer',
  'Not Reachable',
  'Switched Off',
  'Busy',
  'Call Disconnected',
]);

const INVALID_NUMBER_OUTCOMES = new Set([
  'Invalid / Wrong Number',
]);

const CALLBACK_OUTCOMES = new Set([
  'Callback Requested',
]);

const TERMINAL_STOP_OUTCOMES = new Set([
  ...SUCCESS_OUTCOMES,
  'Not Interested',
]);

const EXAM_CATEGORIES = [
  'Holy Quran Recitation',
  'Complete Memorization of the Holy Quran with Tafsir',
];

const KERALA_DISTRICTS = [
  'Alappuzha',
  'Ernakulam',
  'Idukki',
  'Kannur',
  'Kasaragod',
  'Kollam',
  'Kottayam',
  'Kozhikode North',
  'Kozhikode South',
  'Malappuram East',
  'Malappuram West',
  'Palakkad',
  'Pathanamthitta',
  'Thiruvananthapuram',
  'Thrissur',
  'Wayanad',
];

const NOTIFICATION_TYPES = {
  THREE_UNSUCCESSFUL_CALLS: 'THREE_UNSUCCESSFUL_CALLS',
  CALLBACK_REQUESTED: 'CALLBACK_REQUESTED',
  FOLLOWUP_OVERDUE: 'FOLLOWUP_OVERDUE',
  SUCCESSFUL_CONTACT: 'SUCCESSFUL_CONTACT',
  INVALID_NUMBER: 'INVALID_NUMBER',
  EMAIL_DELIVERY_FAILURE: 'EMAIL_DELIVERY_FAILURE',
  NEW_STUDENT_ASSIGNMENT: 'NEW_STUDENT_ASSIGNMENT',
};

const EMAIL_SUBJECT_THREE_ATTEMPTS =
  'Important: India Holy Quran Award – Kerala Initial Screening Contact Notice';

module.exports = {
  ROLES,
  CALL_OUTCOMES,
  COMMUNICATION_STATUSES,
  SUCCESS_OUTCOMES,
  UNREACHABLE_OUTCOMES,
  INVALID_NUMBER_OUTCOMES,
  CALLBACK_OUTCOMES,
  TERMINAL_STOP_OUTCOMES,
  EXAM_CATEGORIES,
  KERALA_DISTRICTS,
  NOTIFICATION_TYPES,
  EMAIL_SUBJECT_THREE_ATTEMPTS,
};

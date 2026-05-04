// Jest mock for expo-sqlite
export const openDatabaseAsync = jest.fn().mockResolvedValue({
  execAsync: jest.fn(),
  runAsync: jest.fn(),
  getFirstAsync: jest.fn(),
  getAllAsync: jest.fn(),
});

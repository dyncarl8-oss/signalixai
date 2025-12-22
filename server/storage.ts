import { UserCredits, AdminBalance, CommissionPayment, InsertCommissionPayment, Withdrawal, InsertWithdrawal, Admin, InsertAdmin, AdminAdjustment, InsertAdminAdjustment, ChatSessionWithMessages, Message, AnalysisStage } from "@shared/schema";
import { UserModel, CommissionPaymentModel, WithdrawalModel, AdminModel, AdminAdjustmentModel, ChatSessionModel } from "./db";

export interface IStorage {
  getUserCredits(userId: string): Promise<UserCredits | undefined>;
  setUserCredits(userId: string, credits: number): Promise<void>;
  decrementUserCredits(userId: string): Promise<boolean>;
  incrementUserCredits(userId: string, amount: number): Promise<void>;
  grantUnlimitedAccess(userId: string): Promise<void>;
  revokeUnlimitedAccess(userId: string): Promise<void>;
  upsertUser(userData: { id: string; username: string; name: string; profilePictureUrl?: string | null }): Promise<void>;
  
  registerAdmin(userId: string, companyId?: string): Promise<void>;
  removeAdmin(userId: string, companyId: string): Promise<void>;
  getAdminByUserId(userId: string): Promise<Admin | null>;
  getAdminByCompanyId(companyId: string): Promise<Admin | null>;
  isAdminForCompany(userId: string, companyId: string): Promise<boolean>;
  getAllAdmins(companyId?: string): Promise<Admin[]>;
  adjustAdminBalance(userId: string, amount: number, performedBy: string, reason?: string): Promise<void>;
  recordAdminAdjustment(adjustment: InsertAdminAdjustment): Promise<void>;
  getAdminAdjustments(targetAdminUserId: string, limit?: number): Promise<AdminAdjustment[]>;
  
  recordCommissionPayment(payment: InsertCommissionPayment): Promise<void>;
  getAdminBalance(adminUserId: string): Promise<AdminBalance>;
  getCommissionPayments(adminUserId: string, limit?: number): Promise<CommissionPayment[]>;
  getAllCommissionPayments(limit?: number): Promise<CommissionPayment[]>;
  getTotalAdminBalance(): Promise<AdminBalance>;
  hasProcessedPayment(paymentId: string, adminUserId?: string): Promise<boolean>;
  
  recordWithdrawal(withdrawal: InsertWithdrawal): Promise<void>;
  updateWithdrawalStatus(id: string, status: string, transferId?: string): Promise<void>;
  getWithdrawals(adminUserId: string, limit?: number): Promise<Withdrawal[]>;
  
  createChatSession(userId: string): Promise<string>;
  getChatSession(sessionId: string): Promise<ChatSessionWithMessages | null>;
  getUserChatSessions(userId: string, limit?: number): Promise<ChatSessionWithMessages[]>;
  updateChatSession(sessionId: string, messages: Message[], tradingPair?: string, timeframe?: string, analysisStages?: AnalysisStage[]): Promise<void>;
  deleteChatSession(sessionId: string): Promise<void>;
}

export class MongoStorage implements IStorage {
  async getUserCredits(userId: string): Promise<UserCredits | undefined> {
    const user = await UserModel.findOne({ id: userId });
    if (!user) {
      return undefined;
    }
    return { 
      userId: user.id, 
      credits: user.credits,
      hasUnlimitedAccess: user.hasUnlimitedAccess || false
    };
  }

  async setUserCredits(userId: string, credits: number): Promise<void> {
    await UserModel.findOneAndUpdate(
      { id: userId },
      { 
        $set: { credits, updatedAt: new Date() },
        $setOnInsert: { 
          username: userId,
          name: userId,
          profilePictureUrl: null,
        }
      },
      { upsert: true, new: true }
    );
  }

  async decrementUserCredits(userId: string): Promise<boolean> {
    const user = await UserModel.findOne({ id: userId });
    if (!user) {
      return false;
    }
    
    // If user has unlimited access, always allow (don't decrement)
    if (user.hasUnlimitedAccess) {
      return true;
    }
    
    // Otherwise, check if they have credits
    if (user.credits <= 0) {
      return false;
    }
    
    user.credits -= 1;
    user.updatedAt = new Date();
    await user.save();
    return true;
  }

  async incrementUserCredits(userId: string, amount: number): Promise<void> {
    const user = await UserModel.findOne({ id: userId });
    if (user) {
      user.credits += amount;
      user.updatedAt = new Date();
      await user.save();
    } else {
      await UserModel.create({
        id: userId,
        username: "unknown",
        name: "Unknown User",
        credits: amount,
      });
    }
  }

  async grantUnlimitedAccess(userId: string): Promise<void> {
    await UserModel.findOneAndUpdate(
      { id: userId },
      { 
        $set: { 
          hasUnlimitedAccess: true,
          updatedAt: new Date() 
        }
      },
      { upsert: true, new: true }
    );
  }

  async revokeUnlimitedAccess(userId: string): Promise<void> {
    await UserModel.findOneAndUpdate(
      { id: userId },
      { 
        $set: { 
          hasUnlimitedAccess: false,
          updatedAt: new Date() 
        }
      },
      { upsert: true, new: true }
    );
  }

  async upsertUser(userData: { 
    id: string; 
    username: string; 
    name: string; 
    profilePictureUrl?: string | null 
  }): Promise<void> {
    await UserModel.findOneAndUpdate(
      { id: userData.id },
      {
        username: userData.username,
        name: userData.name,
        profilePictureUrl: userData.profilePictureUrl,
        updatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  async registerAdmin(userId: string, companyId?: string): Promise<void> {
    const updateFields: any = {
      userId,
      updatedAt: new Date(),
    };
    
    // Only update companyId if provided (avoid overwriting with undefined)
    if (companyId) {
      updateFields.companyId = companyId;
    }
    
    await AdminModel.findOneAndUpdate(
      { userId },
      {
        $set: updateFields,
        $setOnInsert: {
          id: `admin_${userId}_${Date.now()}`,
          commissionShare: 100,
        }
      },
      { 
        upsert: true, 
        new: true,
      }
    );
  }

  async removeAdmin(userId: string, companyId: string): Promise<void> {
    // Remove admin record for this specific company
    // This will also match legacy records where companyId is null/undefined
    await AdminModel.deleteMany({ 
      userId, 
      $or: [
        { companyId },
        { companyId: { $exists: false } },
        { companyId: null }
      ]
    });
  }

  async getAdminByUserId(userId: string): Promise<Admin | null> {
    const admin = await AdminModel.findOne({ userId }).lean();
    if (!admin) return null;
    return {
      id: admin.id,
      userId: admin.userId,
      companyId: admin.companyId || null,
      commissionShare: admin.commissionShare,
      manualBalanceAdjustment: admin.manualBalanceAdjustment || 0,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    };
  }

  async getAdminByCompanyId(companyId: string): Promise<Admin | null> {
    const admin = await AdminModel.findOne({ companyId }).lean();
    if (!admin) return null;
    return {
      id: admin.id,
      userId: admin.userId,
      companyId: admin.companyId || null,
      commissionShare: admin.commissionShare,
      manualBalanceAdjustment: admin.manualBalanceAdjustment || 0,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    };
  }

  async isAdminForCompany(userId: string, companyId: string): Promise<boolean> {
    const admin = await AdminModel.findOne({ userId, companyId }).lean();
    return admin !== null;
  }

  async getAllAdmins(companyId?: string): Promise<Admin[]> {
    const query = companyId ? { companyId } : {};
    const admins = await AdminModel.find(query).lean();
    return admins.map(a => ({
      id: a.id,
      userId: a.userId,
      companyId: a.companyId || null,
      commissionShare: a.commissionShare,
      manualBalanceAdjustment: a.manualBalanceAdjustment || 0,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  }

  async adjustAdminBalance(userId: string, amount: number, performedBy: string, reason?: string): Promise<void> {
    // Get current balance before adjustment
    const balanceBefore = await this.getAdminBalance(userId);
    
    // Perform the adjustment
    await AdminModel.findOneAndUpdate(
      { userId },
      { 
        $inc: { manualBalanceAdjustment: amount },
        $set: { updatedAt: new Date() }
      }
    );
    
    // Get new balance after adjustment
    const balanceAfter = await this.getAdminBalance(userId);
    
    // Record the adjustment in audit log
    await this.recordAdminAdjustment({
      id: `adj_${Date.now()}_${userId}`,
      performedBy,
      targetAdminUserId: userId,
      amount,
      reason: reason || null,
      balanceBefore: balanceBefore.balance,
      balanceAfter: balanceAfter.balance,
    });
  }

  async recordAdminAdjustment(adjustment: InsertAdminAdjustment): Promise<void> {
    await AdminAdjustmentModel.create(adjustment);
  }

  async getAdminAdjustments(targetAdminUserId: string, limit: number = 50): Promise<AdminAdjustment[]> {
    const adjustments = await AdminAdjustmentModel
      .find({ targetAdminUserId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    
    return adjustments.map(a => ({
      id: a.id,
      performedBy: a.performedBy,
      targetAdminUserId: a.targetAdminUserId,
      amount: a.amount,
      reason: a.reason || null,
      balanceBefore: a.balanceBefore,
      balanceAfter: a.balanceAfter,
      createdAt: a.createdAt,
    }));
  }

  async recordCommissionPayment(payment: InsertCommissionPayment): Promise<void> {
    try {
      await CommissionPaymentModel.create(payment);
    } catch (error: any) {
      // If duplicate key error (code 11000), this payment was already processed - silently succeed
      if (error.code === 11000) {
        console.log(`[Storage] Commission ${payment.id} already recorded, skipping`);
        return;
      }
      // Re-throw other errors
      throw error;
    }
  }

  async hasProcessedPayment(paymentId: string, adminUserId?: string): Promise<boolean> {
    const query: any = { paymentId };
    if (adminUserId) {
      query.adminUserId = adminUserId;
    }
    const existing = await CommissionPaymentModel.findOne(query);
    return existing !== null;
  }

  async getAdminBalance(adminUserId: string): Promise<AdminBalance> {
    const admin = await AdminModel.findOne({ userId: adminUserId });
    const payments = await CommissionPaymentModel.find({ adminUserId });
    const withdrawals = await WithdrawalModel.find({ 
      adminUserId, 
      status: 'completed' 
    });
    
    const totalEarned = payments.reduce((sum, p) => sum + p.commissionAmount, 0);
    const totalWithdrawn = withdrawals.reduce((sum, w) => sum + w.amount, 0);
    const manualAdjustment = admin?.manualBalanceAdjustment || 0;
    const balance = totalEarned - totalWithdrawn + manualAdjustment;
    const paymentCount = payments.length;
    
    return {
      adminUserId,
      balance,
      paymentCount,
    };
  }

  async getCommissionPayments(adminUserId: string, limit: number = 50): Promise<CommissionPayment[]> {
    const payments = await CommissionPaymentModel
      .find({ adminUserId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    
    return payments.map(p => ({
      id: p.id,
      paymentId: p.paymentId,
      adminUserId: p.adminUserId,
      amount: p.amount,
      commissionAmount: p.commissionAmount,
      customerUserId: p.customerUserId || null,
      customerEmail: p.customerEmail || null,
      createdAt: p.createdAt,
    }));
  }

  async getAllCommissionPayments(limit: number = 50): Promise<CommissionPayment[]> {
    const payments = await CommissionPaymentModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    
    return payments.map(p => ({
      id: p.id,
      paymentId: p.paymentId,
      adminUserId: p.adminUserId,
      amount: p.amount,
      commissionAmount: p.commissionAmount,
      customerUserId: p.customerUserId || null,
      customerEmail: p.customerEmail || null,
      createdAt: p.createdAt,
    }));
  }

  async getTotalAdminBalance(): Promise<AdminBalance> {
    const allPayments = await CommissionPaymentModel.find({});
    const allWithdrawals = await WithdrawalModel.find({ status: 'completed' });
    const allAdmins = await AdminModel.find({});
    
    const totalEarned = allPayments.reduce((sum, p) => sum + p.commissionAmount, 0);
    const totalWithdrawn = allWithdrawals.reduce((sum, w) => sum + w.amount, 0);
    const totalManualAdjustments = allAdmins.reduce((sum, a) => sum + (a.manualBalanceAdjustment || 0), 0);
    const balance = totalEarned - totalWithdrawn + totalManualAdjustments;
    const paymentCount = allPayments.length;
    
    return {
      adminUserId: "all_admins",
      balance,
      paymentCount,
    };
  }

  async recordWithdrawal(withdrawal: InsertWithdrawal): Promise<void> {
    await WithdrawalModel.create(withdrawal);
  }

  async updateWithdrawalStatus(id: string, status: string, transferId?: string): Promise<void> {
    const update: any = { status };
    if (transferId) {
      update.transferId = transferId;
    }
    await WithdrawalModel.findOneAndUpdate({ id }, update);
  }

  async getWithdrawals(adminUserId: string, limit: number = 50): Promise<Withdrawal[]> {
    const withdrawals = await WithdrawalModel
      .find({ adminUserId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    
    return withdrawals.map(w => ({
      id: w.id,
      adminUserId: w.adminUserId,
      amount: w.amount,
      transferId: w.transferId || null,
      status: w.status,
      createdAt: w.createdAt,
    }));
  }

  async createChatSession(userId: string): Promise<string> {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await ChatSessionModel.create({
      id: sessionId,
      userId,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return sessionId;
  }

  async getChatSession(sessionId: string): Promise<ChatSessionWithMessages | null> {
    const session = await ChatSessionModel.findOne({ id: sessionId }).lean();
    if (!session) {
      return null;
    }
    
    return {
      id: session.id,
      userId: session.userId,
      tradingPair: session.tradingPair || null,
      timeframe: session.timeframe || null,
      messages: session.messages || [],
      analysisStages: session.analysisStages || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async getUserChatSessions(userId: string, limit: number = 20): Promise<ChatSessionWithMessages[]> {
    const sessions = await ChatSessionModel
      .find({ userId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
    
    return sessions.map(session => ({
      id: session.id,
      userId: session.userId,
      tradingPair: session.tradingPair || null,
      timeframe: session.timeframe || null,
      messages: session.messages || [],
      analysisStages: session.analysisStages || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
  }

  async updateChatSession(sessionId: string, messages: Message[], tradingPair?: string, timeframe?: string, analysisStages?: AnalysisStage[]): Promise<void> {
    const update: any = {
      messages,
      updatedAt: new Date(),
    };
    
    if (tradingPair) {
      update.tradingPair = tradingPair;
    }
    if (timeframe) {
      update.timeframe = timeframe;
    }
    if (analysisStages !== undefined) {
      update.analysisStages = analysisStages;
    }
    
    await ChatSessionModel.findOneAndUpdate(
      { id: sessionId },
      { $set: update },
      { new: true }
    );
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    await ChatSessionModel.deleteOne({ id: sessionId });
  }
}

export const storage = new MongoStorage();
